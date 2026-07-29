import type {
  Parameter,
  ParameterHistoryEntry,
  ParameterMetadata,
  ParameterTier,
  ParameterType,
} from '../../domain/Parameter.js';

/**
 * Contrato de acesso ao Parameter Store.
 *
 * Nenhum tipo do SDK da AWS pode aparecer nesta interface. `application/` e
 * `domain/` conhecem apenas isto, e por isso trocar `AwsSsmStoreAdapter` por
 * `LocalFileStoreAdapter` é troca de implementação, não refatoração.
 *
 * Todo método pode lançar `AppError` (ver `src/domain/errors.ts`). Erros do
 * fornecedor precisam ser traduzidos dentro do adapter — não podem escapar.
 */
export interface ParameterStorePort {
  /**
   * Lista metadados dos parâmetros, opcionalmente sob um prefixo de path.
   * Não devolve valores: listar não deve carregar segredo para a memória.
   */
  list(options?: ListOptions): Promise<ParameterMetadata[]>;

  /**
   * Lê um parâmetro com o valor.
   *
   * `SecureString` é lido decriptado (o equivalente a `WithDecryption: true`).
   * O valor retornado é tratado como segredo pelas camadas de cima.
   *
   * @throws {ParameterNotFoundError}
   */
  get(name: string): Promise<Parameter>;

  /**
   * Grava um novo valor.
   *
   * O chamador é responsável por passar `type`, `tier` e `keyId` iguais aos
   * do parâmetro original — preservá-los é requisito, não opção.
   *
   * `options.expectedVersion` é obrigatório e é o que impede as duas formas de
   * escrita acidental. Ver `PutOptions`.
   *
   * @returns o número da versão resultante.
   * @throws {ParameterNotFoundError} quando se esperava uma versão e o
   *         parâmetro não existe.
   * @throws {VersionMismatchError} quando a versão atual não é a esperada.
   * @throws {ParameterAlreadyExistsError} quando se esperava criar e já existe.
   */
  put(name: string, value: string, options: PutOptions): Promise<PutResult>;

  /** Histórico de versões, da mais recente para a mais antiga. */
  history(name: string): Promise<ParameterHistoryEntry[]>;
}

export interface ListOptions {
  /** Prefixo de hierarquia. Ex.: `/prod`. Sem prefixo, lista tudo. */
  readonly pathPrefix?: string | undefined;
  /** `true` desce a hierarquia inteira sob o prefixo. */
  readonly recursive?: boolean | undefined;
}

/** Sentinela de `expectedVersion` para "espero que o parâmetro não exista". */
export const EXPECT_NEW_PARAMETER = 0;

export interface PutOptions {
  readonly type: ParameterType;
  readonly tier: ParameterTier;
  /** Obrigatório quando `type` é `SecureString`; ignorado nos outros casos. */
  readonly keyId?: string | undefined;
  readonly description?: string | undefined;
  /**
   * Versão que o chamador leu e da qual a edição partiu.
   *
   * Obrigatório de propósito. É o campo que torna estruturais as duas regras
   * que o spec exige, em vez de deixá-las como disciplina de quem chama:
   *
   * - **Nunca sobrescrever às cegas.** O SSM não tem put condicional, mas
   *   devolve `Version`. O adapter compara antes de gravar e aborta se a
   *   versão mudou, então uma gravação de outra pessoa não é perdida.
   *
   * - **Nunca criar por efeito colateral.** `PutParameter` com
   *   `Overwrite: true` cria o parâmetro se ele não existir, e nesse caso não
   *   há original de onde herdar `Type`, `Tier` e `KeyId`. Com
   *   `expectedVersion >= 1` o adapter exige que o parâmetro exista.
   *
   * Use `EXPECT_NEW_PARAMETER` (0) para criação deliberada — o fluxo explícito
   * de criação é da Fase 4. Passar 0 sem querer é bem mais difícil do que
   * esquecer de checar a versão.
   */
  readonly expectedVersion: number;
}

export interface PutResult {
  readonly version: number;
  readonly tier: ParameterTier;
}
