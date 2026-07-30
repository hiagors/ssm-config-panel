import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ParameterAlreadyExistsError,
  ParameterNameCollisionError,
  ParameterNotFoundError,
  VersionMismatchError,
} from '../../domain/errors.js';
import { LocalFileStoreAdapter } from './LocalFileStoreAdapter.js';

async function makeAdapter(): Promise<{ adapter: LocalFileStoreAdapter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ssm-store-'));
  return { adapter: new LocalFileStoreAdapter(root), root };
}

/** Nome do arquivo de um parâmetro, na convenção do adapter. */
function fileFor(root: string, name: string): string {
  return join(root, `${name.slice(1).split('/').join('#').toLowerCase()}.json`);
}

/** Escreve um envelope à mão, para testar leitura sem passar pelo `put`. */
async function writeEnvelope(
  root: string,
  name: string,
  envelope: Record<string, unknown>,
): Promise<void> {
  await writeFile(fileFor(root, name), JSON.stringify(envelope), { mode: 0o600 });
}

const STANDARD = { type: 'String', tier: 'Standard' } as const;

describe('LocalFileStoreAdapter — get', () => {
  it('lê o valor exatamente como está no arquivo', async () => {
    const { adapter, root } = await makeAdapter();
    const raw = '{\n  "b": 1,\n  "a": 2\n}\n';
    await writeEnvelope(root, '/example/demo', { name: '/example/demo', value: raw });

    const parameter = await adapter.get('/example/demo');

    // Byte a byte: a ordem das chaves e o espaçamento precisam sobreviver.
    expect(parameter.value).toBe(raw);
  });

  it('lança ParameterNotFoundError quando não existe', async () => {
    const { adapter } = await makeAdapter();

    await expect(adapter.get('/example/ausente')).rejects.toThrow(ParameterNotFoundError);
  });

  it('assume defaults do SSM quando o envelope só tem name e value', async () => {
    const { adapter, root } = await makeAdapter();
    await writeEnvelope(root, '/demo', { name: '/demo', value: '{}' });

    const { metadata } = await adapter.get('/demo');

    expect(metadata.type).toBe('String');
    expect(metadata.tier).toBe('Standard');
    expect(metadata.version).toBe(1);
  });

  it('respeita os metadados do envelope', async () => {
    const { adapter, root } = await makeAdapter();
    await writeEnvelope(root, '/demo', {
      name: '/demo',
      type: 'SecureString',
      tier: 'Advanced',
      keyId: 'alias/aws/ssm',
      version: 7,
      value: '{}',
    });

    const { metadata } = await adapter.get('/demo');

    expect(metadata.type).toBe('SecureString');
    expect(metadata.tier).toBe('Advanced');
    expect(metadata.keyId).toBe('alias/aws/ssm');
    expect(metadata.version).toBe(7);
  });

  it('ignora campo de metadado inválido em vez de quebrar', async () => {
    const { adapter, root } = await makeAdapter();
    await writeEnvelope(root, '/demo', {
      name: '/demo',
      type: 'Nonsense',
      version: -3,
      value: '{}',
    });

    const { metadata } = await adapter.get('/demo');

    expect(metadata.type).toBe('String');
    expect(metadata.version).toBe(1);
  });

  it('erro de arquivo corrompido não expõe o conteúdo do arquivo', async () => {
    const { adapter, root } = await makeAdapter();
    const sentinel = 'SENTINEL-no-arquivo-4d1c';
    await writeFile(fileFor(root, '/demo'), `{"value": "${sentinel}"`);

    await expect(adapter.get('/demo')).rejects.toThrow(
      expect.objectContaining({
        publicMessage: expect.not.stringContaining(sentinel) as unknown as string,
      }),
    );
  });

  it('arquivo sem name nem value é tratado como ausente, não como parâmetro vazio', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(fileFor(root, '/demo'), '{"qualquer":"coisa"}');

    await expect(adapter.get('/demo')).rejects.toThrow(ParameterNotFoundError);
  });
});

describe('LocalFileStoreAdapter — put', () => {
  it('grava um arquivo plano com valor e metadados juntos', async () => {
    const { adapter, root } = await makeAdapter();
    const value = '{"a":1}';

    const result = await adapter.put('/example/demo/env', value, {
      ...STANDARD,
      expectedVersion: 0,
    });

    expect(result.version).toBe(1);

    const envelope = JSON.parse(
      await readFile(join(root, 'example#demo#env.json'), 'utf8'),
    ) as Record<string, unknown>;

    expect(envelope['name']).toBe('/example/demo/env');
    expect(envelope['value']).toBe(value);
    expect(envelope['type']).toBe('String');
    expect(envelope['version']).toBe(1);
  });

  it('não cria diretórios: a hierarquia do name vira nome de arquivo', async () => {
    const { adapter, root } = await makeAdapter();

    await adapter.put('/a/b/c/d', '{}', { ...STANDARD, expectedVersion: 0 });

    expect(await readFile(join(root, 'a#b#c#d.json'), 'utf8')).toContain('"/a/b/c/d"');
  });

  it('cria arquivos com permissão 0600', async () => {
    const { adapter, root } = await makeAdapter();

    await adapter.put('/example/demo', '{}', {
      type: 'SecureString',
      tier: 'Standard',
      keyId: 'alias/aws/ssm',
      expectedVersion: 0,
    });

    expect((await stat(join(root, 'example#demo.json'))).mode & 0o777).toBe(0o600);
  });

  it('cria o diretório do store com permissão 0700', async () => {
    const root = join(await mkdtemp(join(tmpdir(), 'ssm-root-')), 'store');
    const adapter = new LocalFileStoreAdapter(root);

    await adapter.put('/example/demo', '{}', { ...STANDARD, expectedVersion: 0 });

    expect((await stat(root)).mode & 0o777).toBe(0o700);
  });

  it('incrementa a versão a cada gravação', async () => {
    const { adapter } = await makeAdapter();

    // Cada gravação declara a versão de que partiu: 0 para criar, 1 para
    // sobrescrever a versão 1.
    expect(
      (await adapter.put('/demo', '{"v":1}', { ...STANDARD, expectedVersion: 0 })).version,
    ).toBe(1);
    expect(
      (await adapter.put('/demo', '{"v":2}', { ...STANDARD, expectedVersion: 1 })).version,
    ).toBe(2);
    expect((await adapter.get('/demo')).value).toBe('{"v":2}');
  });

  it('preserva keyId apenas em SecureString', async () => {
    const { adapter } = await makeAdapter();

    await adapter.put('/secreto', '{}', {
      type: 'SecureString',
      tier: 'Standard',
      keyId: 'alias/minha-chave',
      expectedVersion: 0,
    });
    await adapter.put('/comum', '{}', {
      ...STANDARD,
      keyId: 'alias/minha-chave',
      expectedVersion: 0,
    });

    expect((await adapter.get('/secreto')).metadata.keyId).toBe('alias/minha-chave');
    expect((await adapter.get('/comum')).metadata.keyId).toBeUndefined();
  });

  it('não deixa arquivo temporário para trás', async () => {
    const { adapter } = await makeAdapter();

    await adapter.put('/demo', '{}', { ...STANDARD, expectedVersion: 0 });

    expect(await adapter.list()).toHaveLength(1);
  });
});

describe('LocalFileStoreAdapter — list', () => {
  it('lista os parâmetros gravados', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/example/a', '{}', { ...STANDARD, expectedVersion: 0 });
    await adapter.put('/example/b', '{}', { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.list()).map((m) => m.name)).toEqual(['/example/a', '/example/b']);
  });

  it('ignora arquivo que não é .json', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(join(root, 'README.txt'), 'anotação');
    await adapter.put('/demo', '{}', { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.list()).map((m) => m.name)).toEqual(['/demo']);
  });

  it('ignora .json que não é envelope de parâmetro', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(join(root, 'anotacao.json'), '{"lembrete":"isto nao e um parametro"}');
    await adapter.put('/demo', '{}', { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.list()).map((m) => m.name)).toEqual(['/demo']);
  });

  it('devolve o name completo, com a hierarquia', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/a/b/c/d', '{}', { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.list()).map((m) => m.name)).toEqual(['/a/b/c/d']);
  });

  it('filtra por prefixo de path', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{}', { ...STANDARD, expectedVersion: 0 });
    await adapter.put('/staging/env', '{}', { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.list({ pathPrefix: '/prod' })).map((m) => m.name)).toEqual(['/prod/env']);
  });

  it('com recursive=false não desce além de um nível', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{}', { ...STANDARD, expectedVersion: 0 });
    await adapter.put('/prod/billing/env', '{}', { ...STANDARD, expectedVersion: 0 });

    const names = (await adapter.list({ pathPrefix: '/prod', recursive: false })).map((m) => m.name);

    expect(names).toEqual(['/prod/env']);
  });

  it('store inexistente devolve lista vazia', async () => {
    const adapter = new LocalFileStoreAdapter(join(tmpdir(), 'ssm-store-inexistente-7a2e'));

    expect(await adapter.list()).toEqual([]);
  });

  it('não devolve valor nenhum, mesmo lendo o arquivo inteiro', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/demo', '{"segredo":"nao-deve-vazar"}', {
      ...STANDARD,
      expectedVersion: 0,
    });

    // O arquivo é lido do disco para pegar os metadados, mas `list()` devolve
    // somente metadados: nada do valor pode aparecer no resultado.
    expect(JSON.stringify(await adapter.list())).not.toContain('nao-deve-vazar');
  });
});

describe('LocalFileStoreAdapter — contrato de expectedVersion', () => {
  it('expectedVersion 0 cria quando não existe', async () => {
    const { adapter } = await makeAdapter();

    expect((await adapter.put('/novo', '{}', { ...STANDARD, expectedVersion: 0 })).version).toBe(1);
  });

  it('expectedVersion 0 recusa quando já existe', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/existe', '{"v":1}', { ...STANDARD, expectedVersion: 0 });

    await expect(
      adapter.put('/existe', '{"v":2}', { ...STANDARD, expectedVersion: 0 }),
    ).rejects.toThrow(ParameterAlreadyExistsError);
  });

  it('expectedVersion >= 1 NÃO cria quando o parâmetro não existe', async () => {
    // `PutParameter` com `Overwrite: true` criaria aqui. Não criamos: sem
    // original não há Type, Tier nem KeyId de onde herdar.
    const { adapter, root } = await makeAdapter();

    await expect(adapter.put('/ausente', '{}', { ...STANDARD, expectedVersion: 1 })).rejects.toThrow(
      ParameterNotFoundError,
    );

    await expect(readFile(fileFor(root, '/ausente'), 'utf8')).rejects.toThrow();
  });

  it('expectedVersion divergente aborta e NÃO grava', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.put('/p', '{"original":true}', { ...STANDARD, expectedVersion: 0 });
    await adapter.put('/p', '{"segunda":true}', { ...STANDARD, expectedVersion: 1 });

    // Agora está na versão 2; quem partiu da 1 não pode gravar.
    await expect(
      adapter.put('/p', '{"invasor":true}', { ...STANDARD, expectedVersion: 1 }),
    ).rejects.toThrow(VersionMismatchError);

    // A prova de que nada foi tocado no disco.
    const envelope = JSON.parse(await readFile(fileFor(root, '/p'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(envelope['value']).toBe('{"segunda":true}');
    expect((await adapter.get('/p')).metadata.version).toBe(2);
  });

  it('a mensagem pública de conflito diz as duas versões e que nada foi gravado', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/p', '{}', { ...STANDARD, expectedVersion: 0 });
    await adapter.put('/p', '{}', { ...STANDARD, expectedVersion: 1 });

    // `toThrow` casa com `error.message`, que é a mensagem interna em inglês,
    // para desenvolvedor. O que chega ao usuário é a `publicMessage`.
    await expect(adapter.put('/p', '{}', { ...STANDARD, expectedVersion: 1 })).rejects.toMatchObject(
      {
        code: 'VERSION_MISMATCH',
        httpStatus: 409,
        expectedVersion: 1,
        currentVersion: 2,
        publicMessage: expect.stringContaining('Nada foi sobrescrito'),
      },
    );
  });

  it('expectedVersion correto grava e incrementa', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/p', '{"v":1}', { ...STANDARD, expectedVersion: 0 });

    const result = await adapter.put('/p', '{"v":2}', { ...STANDARD, expectedVersion: 1 });

    expect(result.version).toBe(2);
    expect((await adapter.get('/p')).value).toBe('{"v":2}');
  });

  it('erro de versão não deixa arquivo temporário para trás', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/p', '{}', { ...STANDARD, expectedVersion: 0 });

    await expect(adapter.put('/p', '{}', { ...STANDARD, expectedVersion: 99 })).rejects.toThrow(
      VersionMismatchError,
    );

    expect(await adapter.list()).toHaveLength(1);
  });
});

describe('LocalFileStoreAdapter — colisão de caixa', () => {
  /**
   * O `name` dentro do arquivo é o que decide de quem o arquivo é.
   *
   * O nome do arquivo é minúsculo de propósito, então `/prod/ENV` e `/prod/env`
   * resolvem para o mesmo arquivo em **qualquer** sistema de arquivos — e a
   * comparação de `name` acusa a diferença. No SSM os dois são parâmetros
   * distintos; devolver um no lugar do outro seria erro sem sinal.
   */
  it('get com caixa diferente falha em vez de devolver o parâmetro errado', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{"correto":true}', { ...STANDARD, expectedVersion: 0 });

    await expect(adapter.get('/prod/ENV')).rejects.toThrow(ParameterNameCollisionError);
  });

  it('put com caixa diferente falha em vez de sobrescrever', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.put('/prod/env', '{"original":true}', { ...STANDARD, expectedVersion: 0 });

    await expect(
      adapter.put('/prod/ENV', '{"invasor":true}', { ...STANDARD, expectedVersion: 0 }),
    ).rejects.toThrow(ParameterNameCollisionError);

    // O original tem de continuar intacto.
    const envelope = JSON.parse(await readFile(fileFor(root, '/prod/env'), 'utf8')) as Record<
      string,
      unknown
    >;
    expect(envelope['value']).toBe('{"original":true}');
  });

  it('a mensagem de colisão diz qual name já ocupa o arquivo', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{}', { ...STANDARD, expectedVersion: 0 });

    await expect(adapter.get('/PROD/env')).rejects.toMatchObject({
      code: 'PARAMETER_NAME_COLLISION',
      publicMessage: expect.stringContaining('/prod/env'),
    });
  });
});

describe('LocalFileStoreAdapter — round-trip', () => {
  it('put seguido de get devolve exatamente o mesmo texto', async () => {
    const { adapter } = await makeAdapter();
    // Casos que o serializador precisa preservar: ordem das chaves, int vs
    // float, null vs string vazia, array heterogêneo.
    const value = JSON.stringify(
      {
        z_primeira: 'ordem preservada',
        inteiro: 42,
        flutuante: 42.0,
        flutuante_real: 3.14,
        verdadeiro: true,
        nulo: null,
        vazio: '',
        aninhado: { nivel2: { nivel3: [1, 'dois', false, null, { k: 'v' }] } },
      },
      null,
      2,
    );

    await adapter.put('/example/roundtrip', value, { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.get('/example/roundtrip')).value).toBe(value);
  });

  it('preserva a diferença entre null e string vazia', async () => {
    const { adapter } = await makeAdapter();
    const value = '{"a":null,"b":""}';

    await adapter.put('/example/nulos', value, { ...STANDARD, expectedVersion: 0 });
    const parsed = JSON.parse((await adapter.get('/example/nulos')).value) as Record<
      string,
      unknown
    >;

    expect(parsed['a']).toBeNull();
    expect(parsed['b']).toBe('');
  });

  it('preserva texto que não é JSON', async () => {
    const { adapter } = await makeAdapter();
    const value = 'isto nao e json { mesmo';

    await adapter.put('/example/cru', value, { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.get('/example/cru')).value).toBe(value);
  });

  it('valor com quebra de linha e aspas sobrevive ao envelope', async () => {
    const { adapter } = await makeAdapter();
    // O valor agora mora dentro de um JSON, então precisa de escape correto.
    const value = '{\n  "frase": "ele disse \\"oi\\"",\n  "tab": "a\\tb"\n}';

    await adapter.put('/example/escapes', value, { ...STANDARD, expectedVersion: 0 });

    expect((await adapter.get('/example/escapes')).value).toBe(value);
  });
});
