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
   * Grava um novo valor, sobrescrevendo (`Overwrite: true`).
   *
   * O chamador é responsável por passar `type`, `tier` e `keyId` iguais aos
   * do parâmetro original — preservá-los é requisito, não opção.
   *
   * @returns o número da versão resultante.
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

export interface PutOptions {
  readonly type: ParameterType;
  readonly tier: ParameterTier;
  /** Obrigatório quando `type` é `SecureString`; ignorado nos outros casos. */
  readonly keyId?: string | undefined;
  readonly description?: string | undefined;
}

export interface PutResult {
  readonly version: number;
  readonly tier: ParameterTier;
}
