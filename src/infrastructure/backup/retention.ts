import type { BackupEntry } from './BackupPort.js';

/**
 * Política de retenção dos backups.
 *
 * Função pura: recebe a lista e os limites, devolve o que apagar. Sem `fs`, para
 * poder testar as bordas — e as bordas aqui apagam segredo de disco, então
 * errar tem consequência.
 *
 * `./.backups/` é o único lugar do desenho que guarda em texto claro o que o SSM
 * guarda cifrado. Sem poda, cada save de um `SecureString` deixa mais uma cópia
 * permanente do segredo.
 */

export interface RetentionLimits {
  /** Idade máxima em dias. `undefined` desliga a poda por idade. */
  readonly maxAgeDays: number | undefined;
  /** Quantidade máxima por parâmetro. `undefined` desliga a poda por contagem. */
  readonly maxVersions: number | undefined;
}

export const DEFAULT_RETENTION: RetentionLimits = Object.freeze({
  maxAgeDays: 90,
  maxVersions: 20,
});

export interface RetentionPlan {
  readonly keep: readonly BackupEntry[];
  readonly prune: readonly BackupEntry[];
}

/**
 * Decide o que fica e o que sai.
 *
 * **O mais recente nunca é apagado**, aconteça o que acontecer com os limites.
 * Sem essa regra, um `BACKUP_MAX_AGE_DAYS=1` esquecido no `.env` apagaria a
 * única cópia existente na primeira poda — e a poda roda justamente no momento
 * em que a versão anterior está sendo sobrescrita.
 */
export function planRetention(
  entries: readonly BackupEntry[],
  limits: RetentionLimits,
  now: Date,
): RetentionPlan {
  if (entries.length === 0) {
    return { keep: [], prune: [] };
  }

  // Mais recente primeiro. Timestamp ISO ordena lexicograficamente, mas
  // comparar por instante é explícito e sobrevive a fuso na string.
  const sorted = [...entries].sort(
    (left, right) => instantOf(right.savedAt) - instantOf(left.savedAt),
  );

  const keep: BackupEntry[] = [];
  const prune: BackupEntry[] = [];

  const ageCutoff =
    limits.maxAgeDays === undefined
      ? undefined
      : now.getTime() - limits.maxAgeDays * 24 * 60 * 60 * 1000;

  sorted.forEach((entry, index) => {
    // Índice 0 é o mais recente: intocável.
    if (index === 0) {
      keep.push(entry);
      return;
    }

    if (limits.maxVersions !== undefined && index >= limits.maxVersions) {
      prune.push(entry);
      return;
    }

    if (ageCutoff !== undefined) {
      const instant = instantOf(entry.savedAt);

      // Timestamp ilegível é podado: não dá para julgar a idade, e manter
      // indefinidamente um arquivo com segredo é o lado errado da dúvida.
      if (Number.isNaN(instant) || instant < ageCutoff) {
        prune.push(entry);
        return;
      }
    }

    keep.push(entry);
  });

  return { keep, prune };
}

/** `NaN` para timestamp ilegível, tratado como "podar" acima. */
function instantOf(savedAt: string): number {
  return Date.parse(savedAt);
}

/**
 * Lê os limites do ambiente.
 *
 * Valor ausente cai no padrão; `0` ou negativo **desliga** aquela dimensão, em
 * vez de podar tudo — desligar por engano é recuperável, apagar não.
 */
export function retentionFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): RetentionLimits {
  return {
    maxAgeDays: positiveIntegerOr(
      environment['BACKUP_MAX_AGE_DAYS'],
      DEFAULT_RETENTION.maxAgeDays,
    ),
    maxVersions: positiveIntegerOr(
      environment['BACKUP_MAX_VERSIONS_PER_PARAMETER'],
      DEFAULT_RETENTION.maxVersions,
    ),
  };
}

function positiveIntegerOr(raw: string | undefined, fallback: number | undefined) {
  const trimmed = raw?.trim();

  if (trimmed === undefined || trimmed === '') {
    return fallback;
  }

  const parsed = Number(trimmed);

  if (!Number.isInteger(parsed)) {
    return fallback;
  }

  // `0` e negativo desligam a dimensão.
  return parsed > 0 ? parsed : undefined;
}
