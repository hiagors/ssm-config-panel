import {
  DescribeParametersCommand,
  GetParameterCommand,
  PutParameterCommand,
} from '@aws-sdk/client-ssm';
import type { SSMClient } from '@aws-sdk/client-ssm';
import { describe, expect, it, vi } from 'vitest';
import {
  AwsAccessDeniedError,
  AwsRequestFailedError,
  ParameterNotFoundError,
  ProfileNotAuthenticatedError,
  StoreUnavailableError,
  VersionMismatchError,
  ParameterCreationNotSupportedError,
} from '../../domain/errors.js';
import { AwsSsmStoreAdapter } from './AwsSsmStoreAdapter.js';

const SENTINEL = 'SENTINEL-ssm-8f2c-DO-NOT-LEAK';

/**
 * Client falso, para exercitar o adapter sem tocar em conta AWS.
 *
 * Registra os comandos enviados: várias asserções aqui são sobre **o que foi
 * pedido à AWS**, não só sobre o que voltou. `WithDecryption: true` e o filtro
 * de path são contrato, não detalhe.
 */
function fakeClient(handler: (command: unknown) => unknown): {
  client: SSMClient;
  sent: unknown[];
} {
  const sent: unknown[] = [];

  const client = {
    send: vi.fn(async (command: unknown) => {
      sent.push(command);
      const result = handler(command);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }),
  } as unknown as SSMClient;

  return { client, sent };
}

function makeAdapter(handler: (command: unknown) => unknown): {
  adapter: AwsSsmStoreAdapter;
  sent: unknown[];
} {
  const { client, sent } = fakeClient(handler);

  return {
    adapter: new AwsSsmStoreAdapter('meu-profile', 'us-east-1', undefined, () => client),
    sent,
  };
}

/** Erro no formato que o SDK da AWS lança. */
function awsError(name: string, message = `mensagem crua com ${SENTINEL}`): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

describe('get — lê valor decriptado e completa os metadados', () => {
  it('pede WithDecryption: true', async () => {
    // Sem isso o SecureString voltaria cifrado e a edição estruturada seria
    // impossível.
    const { adapter, sent } = makeAdapter((command) =>
      command instanceof GetParameterCommand
        ? { Parameter: { Name: '/p', Type: 'String', Value: '{}', Version: 3 } }
        : { Parameters: [] },
    );

    await adapter.get('/p');

    const get = sent.find((command) => command instanceof GetParameterCommand);

    expect((get as GetParameterCommand).input.WithDecryption).toBe(true);
  });

  it('completa Tier e KeyId com DescribeParameters', async () => {
    // GetParameter não devolve esses dois campos, e preservá-los na gravação é
    // requisito. Verificado nos tipos do SDK.
    const { adapter } = makeAdapter((command) => {
      if (command instanceof GetParameterCommand) {
        return { Parameter: { Name: '/p', Type: 'SecureString', Value: '{"a":1}', Version: 7 } };
      }
      return {
        Parameters: [
          {
            Name: '/p',
            Type: 'SecureString',
            Tier: 'Advanced',
            KeyId: 'alias/minha-chave',
            Version: 7,
            Description: 'descricao',
          },
        ],
      };
    });

    const parameter = await adapter.get('/p');

    expect(parameter.metadata).toMatchObject({
      name: '/p',
      type: 'SecureString',
      tier: 'Advanced',
      keyId: 'alias/minha-chave',
      version: 7,
      description: 'descricao',
    });
    expect(parameter.value).toBe('{"a":1}');
  });

  it('filtra o Describe por nome exato', async () => {
    const { adapter, sent } = makeAdapter((command) =>
      command instanceof GetParameterCommand
        ? { Parameter: { Name: '/a/b', Type: 'String', Value: '{}', Version: 1 } }
        : { Parameters: [] },
    );

    await adapter.get('/a/b');

    const describe = sent.find((command) => command instanceof DescribeParametersCommand);

    expect((describe as DescribeParametersCommand).input.ParameterFilters).toEqual([
      { Key: 'Name', Option: 'Equals', Values: ['/a/b'] },
    ]);
  });

  it('cai para Standard quando falta permissão de DescribeParameters', async () => {
    // Sem Tier a leitura continua possível; só o aviso de tamanho fica
    // conservador. Bloquear a leitura inteira seria pior.
    const { adapter } = makeAdapter((command) =>
      command instanceof GetParameterCommand
        ? { Parameter: { Name: '/p', Type: 'String', Value: '{}', Version: 1 } }
        : awsError('AccessDeniedException'),
    );

    const parameter = await adapter.get('/p');

    expect(parameter.metadata.tier).toBe('Standard');
    expect(parameter.metadata.keyId).toBeUndefined();
  });

  it('parâmetro sem valor é not found', async () => {
    const { adapter } = makeAdapter(() => ({ Parameter: undefined }));

    await expect(adapter.get('/ausente')).rejects.toThrow(ParameterNotFoundError);
  });

  it('valida o name antes de chamar a AWS', async () => {
    const { adapter, sent } = makeAdapter(() => ({}));

    await expect(adapter.get('sem-barra')).rejects.toThrow(/precisa começar com/);
    expect(sent).toEqual([]);
  });
});

describe('list — busca por prefixo, sem trazer valores', () => {
  it('exige prefixo de path', async () => {
    // Varrer uma conta de produção é paginado, lento e sujeito a throttling.
    const { adapter, sent } = makeAdapter(() => ({ Parameters: [] }));

    await expect(adapter.list()).rejects.toThrow(StoreUnavailableError);
    // A mensagem que o usuário vê é a `publicMessage`; `toThrow` casaria com a
    // interna, que é em inglês e para desenvolvedor.
    await expect(adapter.list({ pathPrefix: '  ' })).rejects.toMatchObject({
      publicMessage: expect.stringContaining('prefixo de path'),
    });
    expect(sent).toEqual([]);
  });

  it('usa DescribeParameters com filtro recursivo de path', async () => {
    const { adapter, sent } = makeAdapter(() => ({ Parameters: [] }));

    await adapter.list({ pathPrefix: '/prod' });

    expect((sent[0] as DescribeParametersCommand).input.ParameterFilters).toEqual([
      { Key: 'Path', Option: 'Recursive', Values: ['/prod'] },
    ]);
  });

  it('usa OneLevel quando recursive é false', async () => {
    const { adapter, sent } = makeAdapter(() => ({ Parameters: [] }));

    await adapter.list({ pathPrefix: '/prod', recursive: false });

    expect(
      (sent[0] as DescribeParametersCommand).input.ParameterFilters?.[0]?.Option,
    ).toBe('OneLevel');
  });

  it('nunca usa GetParametersByPath, que traria os valores', async () => {
    const { adapter, sent } = makeAdapter(() => ({ Parameters: [] }));

    await adapter.list({ pathPrefix: '/prod' });

    expect(sent.every((command) => command instanceof DescribeParametersCommand)).toBe(true);
  });

  it('pagina até o fim', async () => {
    let call = 0;
    const { adapter, sent } = makeAdapter(() => {
      call += 1;
      return call === 1
        ? { Parameters: [{ Name: '/prod/a', Type: 'String', Tier: 'Standard', Version: 1 }], NextToken: 'x' }
        : { Parameters: [{ Name: '/prod/b', Type: 'String', Tier: 'Standard', Version: 1 }] };
    });

    const found = await adapter.list({ pathPrefix: '/prod' });

    expect(sent).toHaveLength(2);
    expect(found.map((item) => item.name)).toEqual(['/prod/a', '/prod/b']);
  });

  it('a listagem não contém valor de parâmetro', async () => {
    const { adapter } = makeAdapter(() => ({
      Parameters: [{ Name: '/prod/a', Type: 'SecureString', Tier: 'Standard', Version: 1 }],
    }));

    const found = await adapter.list({ pathPrefix: '/prod' });

    expect(JSON.stringify(found)).not.toContain('Value');
  });

  it('ordena por name', async () => {
    const { adapter } = makeAdapter(() => ({
      Parameters: [
        { Name: '/prod/z', Type: 'String', Tier: 'Standard', Version: 1 },
        { Name: '/prod/a', Type: 'String', Tier: 'Standard', Version: 1 },
      ],
    }));

    expect((await adapter.list({ pathPrefix: '/prod' })).map((item) => item.name)).toEqual([
      '/prod/a',
      '/prod/z',
    ]);
  });
});

describe('put — grava com PutParameter', () => {
  /** Describe devolvendo um parâmetro na versão informada. */
  function describing(version: number, extra: Record<string, unknown> = {}) {
    return (command: unknown) => {
      if (command instanceof DescribeParametersCommand) {
        return {
          Parameters: [
            { Name: '/p', Type: 'String', Tier: 'Standard', Version: version, ...extra },
          ],
        };
      }
      return { Version: version + 1, Tier: 'Standard' };
    };
  }

  it('usa Overwrite: true e devolve a versão resultante', async () => {
    const { adapter, sent } = makeAdapter(describing(4));

    const result = await adapter.put('/p', '{"a":1}', {
      type: 'String',
      tier: 'Standard',
      expectedVersion: 4,
    });

    const put = sent.find((command) => command instanceof PutParameterCommand);

    expect((put as PutParameterCommand).input).toMatchObject({
      Name: '/p',
      Value: '{"a":1}',
      Overwrite: true,
    });
    expect(result.version).toBe(5);
  });

  it('descreve ANTES de gravar', async () => {
    // A ordem é o que cumpre as duas garantias: não criar por efeito colateral e
    // não sobrescrever às cegas.
    const { adapter, sent } = makeAdapter(describing(1));

    await adapter.put('/p', '{}', { type: 'String', tier: 'Standard', expectedVersion: 1 });

    expect(sent[0]).toBeInstanceOf(DescribeParametersCommand);
    expect(sent[1]).toBeInstanceOf(PutParameterCommand);
  });

  it('preserva Type, Tier e KeyId do que está no store', async () => {
    const { adapter, sent } = makeAdapter(
      describing(2, { Type: 'SecureString', Tier: 'Advanced', KeyId: 'alias/k' }),
    );

    await adapter.put('/p', '{}', {
      // O que o chamador passa não pode rebaixar o que está lá.
      type: 'String',
      tier: 'Standard',
      expectedVersion: 2,
    });

    const put = sent.find((command) => command instanceof PutParameterCommand);

    expect((put as PutParameterCommand).input).toMatchObject({
      Type: 'SecureString',
      Tier: 'Advanced',
      KeyId: 'alias/k',
    });
  });

  it('não envia KeyId em parâmetro que não é SecureString', async () => {
    // Enviar KeyId com Type String é erro na API.
    const { adapter, sent } = makeAdapter(describing(1, { KeyId: 'alias/k' }));

    await adapter.put('/p', '{}', { type: 'String', tier: 'Standard', expectedVersion: 1 });

    const put = sent.find((command) => command instanceof PutParameterCommand);

    expect((put as PutParameterCommand).input.KeyId).toBeUndefined();
  });

  it('versão divergente aborta SEM gravar', async () => {
    const { adapter, sent } = makeAdapter(describing(9));

    await expect(
      adapter.put('/p', '{}', { type: 'String', tier: 'Standard', expectedVersion: 3 }),
    ).rejects.toBeInstanceOf(VersionMismatchError);

    expect(sent.some((command) => command instanceof PutParameterCommand)).toBe(false);
  });

  it('parâmetro inexistente NÃO é criado', async () => {
    // Overwrite: true criaria. O Describe vazio é o que impede.
    const { adapter, sent } = makeAdapter(() => ({ Parameters: [] }));

    await expect(
      adapter.put('/p', '{}', { type: 'String', tier: 'Standard', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ParameterNotFoundError);

    expect(sent.some((command) => command instanceof PutParameterCommand)).toBe(false);
  });

  it('sem permissão de DescribeParameters, recusa gravar', async () => {
    // Também fecha o risco de Tier: sem Describe o get() cai para Standard, e
    // gravar com esse palpite rebaixaria um parâmetro Advanced.
    const { adapter, sent } = makeAdapter((command) =>
      command instanceof DescribeParametersCommand ? awsError('AccessDeniedException') : {},
    );

    await expect(
      adapter.put('/p', '{}', { type: 'String', tier: 'Advanced', expectedVersion: 1 }),
    ).rejects.toBeInstanceOf(ParameterNotFoundError);

    expect(sent.some((command) => command instanceof PutParameterCommand)).toBe(false);
  });

  it('expectedVersion 0 (criar) é recusado', async () => {
    const { adapter, sent } = makeAdapter(describing(1));

    await expect(
      adapter.put('/p', '{}', { type: 'String', tier: 'Standard', expectedVersion: 0 }),
    ).rejects.toBeInstanceOf(ParameterCreationNotSupportedError);

    expect(sent).toEqual([]);
  });

  it('valida o name antes de qualquer chamada', async () => {
    const { adapter, sent } = makeAdapter(describing(1));

    await expect(
      adapter.put('sem-barra', '{}', { type: 'String', tier: 'Standard', expectedVersion: 1 }),
    ).rejects.toThrow(/precisa começar com/);

    expect(sent).toEqual([]);
  });

  it('erro de permissão no Put é traduzido, sem repassar mensagem crua', async () => {
    const { adapter } = makeAdapter((command) =>
      command instanceof PutParameterCommand
        ? awsError('AccessDeniedException')
        : { Parameters: [{ Name: '/p', Type: 'String', Tier: 'Standard', Version: 1 }] },
    );

    await expect(
      adapter.put('/p', '{}', { type: 'String', tier: 'Standard', expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'AWS_ACCESS_DENIED' });
  });
});

describe('tradução de erro da AWS', () => {
  it.each([
    ['AccessDeniedException', AwsAccessDeniedError],
    ['ExpiredTokenException', ProfileNotAuthenticatedError],
    ['UnrecognizedClientException', ProfileNotAuthenticatedError],
    ['CredentialsProviderError', ProfileNotAuthenticatedError],
    ['ParameterNotFound', ParameterNotFoundError],
    ['ThrottlingException', AwsRequestFailedError],
    ['QualquerCoisa', AwsRequestFailedError],
  ])('%s vira o erro de domínio certo', async (awsName, expected) => {
    const { adapter } = makeAdapter(() => awsError(awsName));

    await expect(adapter.get('/p')).rejects.toBeInstanceOf(expected);
  });

  it('token expirado é estado de primeira classe, com código estável', async () => {
    // A UI usa o código para mostrar banner e botão de reautenticar, em vez de
    // tela de erro — e sem perder o rascunho.
    const { adapter } = makeAdapter(() => awsError('ExpiredTokenException'));

    await expect(adapter.get('/p')).rejects.toMatchObject({
      code: 'PROFILE_NOT_AUTHENTICATED',
      httpStatus: 401,
    });
  });

  it('nenhuma mensagem crua do SDK atravessa', async () => {
    const { adapter } = makeAdapter(() => awsError('ThrottlingException'));

    try {
      await adapter.get('/p');
      throw new Error('esperava exceção');
    } catch (error) {
      expect(JSON.stringify(describeError(error))).not.toContain(SENTINEL);
      expect((error as { publicMessage: string }).publicMessage).not.toContain(SENTINEL);
    }
  });

  it('o nome do erro da AWS aparece, porque é estrutura e não conteúdo', async () => {
    const { adapter } = makeAdapter(() => awsError('ThrottlingException'));

    await expect(adapter.get('/p')).rejects.toMatchObject({
      publicMessage: expect.stringContaining('ThrottlingException'),
    });
  });

  it('o profile aparece na mensagem de permissão, para a ação ser acionável', async () => {
    const { adapter } = makeAdapter(() => awsError('AccessDeniedException'));

    await expect(adapter.list({ pathPrefix: '/p' })).rejects.toMatchObject({
      publicMessage: expect.stringContaining('meu-profile'),
    });
  });
});

/** Serializa os campos públicos de um erro, para a asserção de vazamento. */
function describeError(error: unknown): Record<string, unknown> {
  if (typeof error !== 'object' || error === null) {
    return { value: String(error) };
  }

  const record = error as Record<string, unknown>;

  return {
    code: record['code'],
    publicMessage: record['publicMessage'],
    httpStatus: record['httpStatus'],
  };
}
