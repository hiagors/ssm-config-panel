import type { BackupEntry } from './BackupPort.js';

/**
 * Política de retenção dos backups: mantém as N mais recentes por parâmetro.
 *
 * Função pura: recebe a lista e o limite, devolve o que apagar. Sem `fs`, para
 * poder testar as bordas — e as bordas aqui apagam segredo de disco, então
 * errar tem consequência.
 *
 * `./.backups/` é o único lugar do desenho que guarda em texto claro o que o SSM
 * guarda cifrado. Sem poda, cada save de um `SecureString` deixa mais uma cópia
 * permanente do segredo.
 *
 * ── Por que só por contagem ─────────────────────────────────────────────────
 *
 * Havia também poda por idade (`BACKUP_MAX_AGE_DAYS`). Saiu: com o limite de
 * contagem, o acúmulo já é **limitado** — no máximo N cópias por parâmetro,
 * para sempre. A poda por idade só mudava *quais* dessas N ficavam, ao custo de
 * um segundo eixo de configuração, de comparação de instantes e de decidir o que
 * fazer com timestamp ilegível. Num editor de uso pessoal, o teto é o que
 * importa.
 */

/** Quantidade máxima de backups por parâmetro. `undefined` desliga a poda. */
export type RetentionLimit = number | undefined;

export const DEFAULT_MAX_VERSIONS = 20;

export interface RetentionPlan {
  readonly keep: readonly BackupEntry[];
  readonly prune: readonly BackupEntry[];
}

/**
 * Decide o que fica e o que sai, do mais recente para o mais antigo.
 *
 * **O mais recente nunca é apagado**, aconteça o que acontecer com o limite.
 * Sem essa regra, um `BACKUP_MAX_VERSIONS_PER_PARAMETER=0` mal entendido
 * apagaria a única cópia existente — e a poda roda justamente no momento em que
 * a versão anterior está sendo sobrescrita. Por isso `0` **desliga** a poda em
 * vez de apagar tudo.
 */
export function planRetention(
  entries: readonly BackupEntry[],
  maxVersions: RetentionLimit,
): RetentionPlan {
  // Mais recente primeiro. O timestamp é ISO 8601 em UTC (sempre `Z`, gerado
  // pelo próprio adapter), então a ordem lexicográfica é a ordem cronológica.
  const sorted = [...entries].sort((left, right) => right.savedAt.localeCompare(left.savedAt));

  if (maxVersions === undefined) {
    return { keep: sorted, prune: [] };
  }

  // `slice` com no mínimo 1: o índice 0 é intocável.
  const cut = Math.max(1, maxVersions);

  return { keep: sorted.slice(0, cut), prune: sorted.slice(cut) };
}

/**
 * Lê o limite do ambiente.
 *
 * Ausente cai no default; `0` ou negativo **desliga** a poda, em vez de podar
 * tudo — desligar por engano é recuperável, apagar não.
 */
export function retentionFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): RetentionLimit {
  const raw = environment['BACKUP_MAX_VERSIONS_PER_PARAMETER']?.trim();

  if (raw === undefined || raw === '') {
    return DEFAULT_MAX_VERSIONS;
  }

  const parsed = Number(raw);

  if (!Number.isInteger(parsed)) {
    return DEFAULT_MAX_VERSIONS;
  }

  return parsed > 0 ? parsed : undefined;
}
