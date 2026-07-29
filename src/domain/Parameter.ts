/**
 * Modelo de parâmetro independente de fornecedor.
 *
 * Nenhum tipo do SDK da AWS pode aparecer aqui nem em `application/`.
 * Os nomes dos campos espelham o vocabulário do SSM porque é o domínio do
 * problema, mas as definições são nossas.
 */

/** Tipos de parâmetro suportados pelo SSM. */
export const PARAMETER_TYPES = ['String', 'StringList', 'SecureString'] as const;
export type ParameterType = (typeof PARAMETER_TYPES)[number];

/** Tiers do SSM, que definem o limite de tamanho do valor. */
export const PARAMETER_TIERS = ['Standard', 'Advanced', 'Intelligent-Tiering'] as const;
export type ParameterTier = (typeof PARAMETER_TIERS)[number];

/** Limite de bytes do valor, por tier. `Intelligent-Tiering` promove para Advanced. */
export const TIER_VALUE_LIMIT_BYTES: Record<ParameterTier, number> = {
  Standard: 4096,
  Advanced: 8192,
  'Intelligent-Tiering': 8192,
};

/**
 * Metadados de um parâmetro, sem o valor.
 *
 * Pode ser logado e serializado livremente: não carrega segredo algum.
 */
export interface ParameterMetadata {
  /** Name completo, com barra inicial. Ex.: `/prod/billing/env`. */
  readonly name: string;
  readonly type: ParameterType;
  readonly tier: ParameterTier;
  /** ARN ou alias da chave KMS. Presente apenas em `SecureString`. */
  readonly keyId?: string | undefined;
  readonly version: number;
  readonly lastModifiedAt?: string | undefined;
  readonly description?: string | undefined;
}

/**
 * Parâmetro completo, com valor.
 *
 * ATENÇÃO: `value` pode ser conteúdo de `SecureString` decriptado. Nunca
 * escreva este objeto em log, mensagem de erro ou stack trace. Para logar,
 * use apenas o `metadata`.
 */
export interface Parameter {
  readonly metadata: ParameterMetadata;
  /** Valor cru, exatamente como está no store. Não normalizado. */
  readonly value: string;
}

/** Uma versão anterior do parâmetro, vinda do histórico. */
export interface ParameterHistoryEntry {
  readonly metadata: ParameterMetadata;
  readonly value: string;
}

/** `true` quando o valor exige tratamento de segredo na UI e nos logs. */
export function isSecret(metadata: ParameterMetadata): boolean {
  return metadata.type === 'SecureString';
}

/** Tamanho do valor em bytes UTF-8, que é como o SSM conta o limite do tier. */
export function valueSizeInBytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}
