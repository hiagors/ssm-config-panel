import {
  DescribeParametersCommand,
  GetParameterCommand,
  SSMClient,
} from '@aws-sdk/client-ssm';
import type { ParameterMetadata as AwsParameterMetadata } from '@aws-sdk/client-ssm';
import type {
  Parameter,
  ParameterHistoryEntry,
  ParameterMetadata,
  ParameterTier,
  ParameterType,
} from '../../domain/Parameter.js';
import { PARAMETER_TIERS, PARAMETER_TYPES } from '../../domain/Parameter.js';
import {
  AwsAccessDeniedError,
  AwsRequestFailedError,
  ParameterNotFoundError,
  ProfileNotAuthenticatedError,
  StoreUnavailableError,
  WriteNotEnabledError,
  isAppError,
} from '../../domain/errors.js';
import { parseParameterName } from '../../domain/parameterName.js';
import type {
  ListOptions,
  ParameterStorePort,
  PutOptions,
  PutResult,
} from './ParameterStorePort.js';

/**
 * Adapter do SSM real. **Somente-leitura nesta fase.**
 *
 * `put()` lança `WriteNotEnabledError` de propósito: nenhuma escrita em conta
 * real antes de existir backup local. Liberar a escrita é o próximo pacote,
 * junto com o backup e a retenção.
 *
 * ── Por que `DescribeParameters` ────────────────────────────────────────────
 *
 * `GetParameter` **não devolve `Tier` nem `KeyId`** — só `Name`, `Type`,
 * `Value`, `Version`, `LastModifiedDate`, `ARN` e `DataType`. Verificado nos
 * tipos do SDK. Mas preservar `Tier` e `KeyId` na gravação é requisito, e o
 * limite de tamanho da validação depende do `Tier`.
 *
 * Os dois campos só aparecem em `ParameterMetadata`, que vem de
 * `DescribeParameters` ou de `GetParameterHistory`. `GetParameterHistory`
 * pagina em ordem crescente de versão, então pegar a atual exigiria percorrer
 * o histórico inteiro. Sobra `DescribeParameters`, com filtro `Name/Equals`.
 *
 * Consequência de IAM, documentada no README: é preciso `ssm:DescribeParameters`
 * além do que o spec lista, e essa ação **não aceita permissão por recurso** —
 * tem de ser `Resource: "*"`.
 *
 * Para `list()`, `DescribeParameters` também é a escolha certa por outro
 * motivo: ele devolve **apenas metadados**. `GetParametersByPath` traria os
 * valores, carregando segredo na memória do servidor só para desenhar uma
 * lista.
 */
export class AwsSsmStoreAdapter implements ParameterStorePort {
  private client: SSMClient | undefined;

  constructor(
    private readonly profileName: string,
    region: string,
    credentials: unknown,
    /** Injetável para teste; em produção constrói um `SSMClient` de verdade. */
    private readonly clientFactory: () => SSMClient = () =>
      new SSMClient({
        region,
        // Provider explícito. A cadeia default poderia pegar a chave estática
        // de ~/.aws/credentials em vez do SSO.
        credentials: credentials as never,
      }),
  ) {}

  private getClient(): SSMClient {
    this.client ??= this.clientFactory();
    return this.client;
  }

  /**
   * Lista metadados sob um prefixo de path.
   *
   * Prefixo é obrigatório aqui, ao contrário do driver local. Varrer uma conta
   * de produção inteira é lento, caro e sujeito a throttling — e não é o que
   * alguém quer ao abrir a ferramenta.
   */
  async list(options: ListOptions = {}): Promise<ParameterMetadata[]> {
    const rawPrefix = options.pathPrefix?.trim();

    if (rawPrefix === undefined || rawPrefix === '') {
      throw new StoreUnavailableError(
        'list without pathPrefix on aws driver',
        'Informe um prefixo de path para listar (ex.: /prod). Varrer a conta inteira não é ' +
          'viável contra o SSM real.',
      );
    }

    const pathPrefix = parseParameterName(rawPrefix);
    const found: ParameterMetadata[] = [];
    let nextToken: string | undefined;

    do {
      const response = await this.run('DescribeParameters', () =>
        this.getClient().send(
          new DescribeParametersCommand({
            ParameterFilters: [
              {
                Key: 'Path',
                Option: options.recursive === false ? 'OneLevel' : 'Recursive',
                Values: [pathPrefix],
              },
            ],
            MaxResults: 50,
            NextToken: nextToken,
          }),
        ),
      );

      for (const item of response.Parameters ?? []) {
        const metadata = toDomainMetadata(item);
        if (metadata !== undefined) {
          found.push(metadata);
        }
      }

      nextToken = response.NextToken;
    } while (nextToken !== undefined);

    return found.sort((left, right) => left.name.localeCompare(right.name));
  }

  /**
   * Lê o parâmetro com o valor decriptado.
   *
   * Duas chamadas: `GetParameter` traz valor e versão; `DescribeParameters`
   * traz `Tier` e `KeyId`, que o `GetParameter` não devolve.
   */
  async get(name: string): Promise<Parameter> {
    const parameterName = parseParameterName(name);

    const response = await this.run('GetParameter', () =>
      this.getClient().send(
        new GetParameterCommand({
          Name: parameterName,
          // SecureString chega decriptado. Exige kms:Decrypt na policy.
          WithDecryption: true,
        }),
      ),
    );

    const raw = response.Parameter;

    if (raw?.Value === undefined || raw.Name === undefined) {
      throw new ParameterNotFoundError(parameterName);
    }

    const describeMetadata = await this.describeOne(parameterName);

    const metadata: ParameterMetadata = {
      name: raw.Name,
      type: toParameterType(raw.Type) ?? describeMetadata?.type ?? 'String',
      // Sem o Describe não sabemos o tier. Standard é o padrão do SSM, e a
      // consequência de errar é só o aviso de tamanho ficar conservador.
      tier: describeMetadata?.tier ?? 'Standard',
      keyId: describeMetadata?.keyId,
      version: raw.Version ?? describeMetadata?.version ?? 1,
      lastModifiedAt: raw.LastModifiedDate?.toISOString(),
      description: describeMetadata?.description,
    };

    return { metadata, value: raw.Value };
  }

  /**
   * Escrita desabilitada nesta fase.
   *
   * Não é falta de implementação escondida: é decisão de sequência. Backup
   * primeiro, escrita depois, no mesmo pacote.
   */
  async put(name: string, _value: string, _options: PutOptions): Promise<PutResult> {
    throw new WriteNotEnabledError(parseParameterName(name));
  }

  /**
   * Histórico fora de escopo nesta fase, por decisão explícita.
   *
   * Devolve a versão atual para o contrato do port valer nos dois adapters,
   * igual ao driver local.
   */
  async history(name: string): Promise<ParameterHistoryEntry[]> {
    const current = await this.get(name);
    return [{ metadata: current.metadata, value: current.value }];
  }

  /** Metadados de um parâmetro específico, via filtro de nome exato. */
  private async describeOne(
    parameterName: string,
  ): Promise<ParameterMetadata | undefined> {
    try {
      const response = await this.run('DescribeParameters', () =>
        this.getClient().send(
          new DescribeParametersCommand({
            ParameterFilters: [{ Key: 'Name', Option: 'Equals', Values: [parameterName] }],
            MaxResults: 1,
          }),
        ),
      );

      const first = response.Parameters?.[0];

      return first === undefined ? undefined : toDomainMetadata(first);
    } catch (error) {
      // Falta de `ssm:DescribeParameters` não deve impedir a leitura: sem ela
      // perdemos Tier e KeyId, e o save fica bloqueado por não ter o que
      // preservar — mas ver o valor continua possível.
      if (error instanceof AwsAccessDeniedError) {
        return undefined;
      }
      throw error;
    }
  }

  /**
   * Executa a chamada traduzindo erro do SDK para erro de domínio.
   *
   * Recebe um thunk em vez do comando para não perder a tipagem: o `send` do
   * SSMClient é sobrecarregado por comando, e um wrapper genérico colapsaria
   * todas as respostas em `unknown`.
   *
   * Nenhuma mensagem do SDK atravessa: só o nome da classe do erro, que é
   * estrutura e não conteúdo. A resposta do SDK pode embutir o valor da
   * requisição, e um `ParameterNotFound` de `PutParameter` traria o nome.
   */
  private async run<TOutput>(operation: string, call: () => Promise<TOutput>): Promise<TOutput> {
    try {
      return await call();
    } catch (error) {
      throw this.translate(error, operation);
    }
  }

  private translate(error: unknown, operation: string): unknown {
    if (isAppError(error)) {
      return error;
    }

    const name = errorNameOf(error);

    switch (name) {
      case 'ParameterNotFound':
        return new ParameterNotFoundError('(o parâmetro informado)');

      case 'AccessDeniedException':
      case 'AccessDenied':
        return new AwsAccessDeniedError(operation, this.profileName);

      // Token do SSO vencido no meio da operação. Estado de primeira classe.
      case 'ExpiredTokenException':
      case 'ExpiredToken':
      case 'UnrecognizedClientException':
      case 'InvalidClientTokenId':
      case 'CredentialsProviderError':
      case 'SSOTokenProviderFailure':
        return new ProfileNotAuthenticatedError(this.profileName);

      default:
        return new AwsRequestFailedError(operation, name);
    }
  }
}

/** Nome da classe do erro do SDK, sem tocar na mensagem. */
function errorNameOf(error: unknown): string {
  if (typeof error !== 'object' || error === null) {
    return typeof error;
  }

  const record = error as { name?: unknown; constructor?: { name?: string } };

  if (typeof record.name === 'string' && record.name !== '') {
    return record.name;
  }

  return record.constructor?.name ?? 'UnknownError';
}

function toDomainMetadata(raw: AwsParameterMetadata): ParameterMetadata | undefined {
  if (raw.Name === undefined) {
    return undefined;
  }

  return {
    name: raw.Name,
    type: toParameterType(raw.Type) ?? 'String',
    tier: toParameterTier(raw.Tier) ?? 'Standard',
    keyId: raw.KeyId,
    version: raw.Version ?? 1,
    lastModifiedAt: raw.LastModifiedDate?.toISOString(),
    description: raw.Description,
  };
}

function toParameterType(value: unknown): ParameterType | undefined {
  return PARAMETER_TYPES.find((candidate) => candidate === value);
}

function toParameterTier(value: unknown): ParameterTier | undefined {
  return PARAMETER_TIERS.find((candidate) => candidate === value);
}

/** Exportado para teste de tradução de erro sem subir client de verdade. */
export const internals = { errorNameOf, toDomainMetadata };
