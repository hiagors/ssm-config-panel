import type { ParameterMetadata } from '../../domain/Parameter.js';

/**
 * Rede de proteção antes de gravar, e origem do rollback.
 *
 * Existe para que nenhuma escrita — em SSM real ou no store local — aconteça sem
 * uma cópia da versão anterior em disco. É o único ponto do desenho que guarda
 * em texto claro algo que o SSM guarda cifrado, e por isso vem com retenção
 * obrigatória.
 *
 * **Falha de backup aborta a gravação.** Não é "melhor esforço": um backup que
 * falha em silêncio é pior que backup nenhum, porque cria a confiança sem a
 * garantia.
 *
 * `list` e `read` são o que transformam a pasta de backups em rollback de
 * verdade: sem eles a cópia existe mas só serve para copiar e colar à mão, que é
 * exatamente o fluxo que esta ferramenta existe para eliminar.
 */
export interface BackupPort {
  /**
   * Guarda a versão atual antes de sobrescrever.
   *
   * @returns descrição do que foi gravado e do que a retenção apagou.
   * @throws {BackupFailedError} quando não conseguiu gravar.
   */
  save(parameter: BackupInput): Promise<BackupResult>;

  /** Backups existentes de um parâmetro, do mais recente para o mais antigo. */
  list(parameterName: string): Promise<readonly BackupEntry[]>;

  /**
   * Lê um backup específico, com o valor.
   *
   * @param savedAt timestamp ISO que identifica o backup, vindo de `list`.
   * @throws {BackupNotFoundError} quando não existe — pode ter sido podado
   *         entre listar e escolher.
   */
  read(parameterName: string, savedAt: string): Promise<BackupFileContents>;
}

export interface BackupInput {
  readonly metadata: ParameterMetadata;
  /**
   * Valor a preservar. Pode ser `SecureString` decriptado — é exatamente por
   * isso que o arquivo nasce com permissão `0600` e a retenção existe.
   */
  readonly value: string;
}

export interface BackupEntry {
  /** ISO 8601, também usado como nome do arquivo. */
  readonly savedAt: string;
  /** Versão do parâmetro que este arquivo preserva. */
  readonly version: number;
  readonly absolutePath: string;
}

export interface BackupResult {
  readonly entry: BackupEntry;
  /** Arquivos apagados pela retenção nesta gravação. */
  readonly pruned: readonly BackupEntry[];
}

/**
 * Envelope gravado em disco.
 *
 * Guarda os metadados junto do valor porque um backup sem eles não serve para
 * rollback: é preciso saber de que versão veio e com que `Type`/`Tier`/`KeyId` o
 * parâmetro estava gravado.
 *
 * ATENÇÃO: `value` pode ser `SecureString` decriptado. Nunca logue este objeto.
 */
export interface BackupFileContents {
  readonly name: string;
  readonly version: number;
  readonly type: string;
  readonly tier: string;
  readonly keyId: string | null;
  readonly savedAt: string;
  readonly value: string;
}
