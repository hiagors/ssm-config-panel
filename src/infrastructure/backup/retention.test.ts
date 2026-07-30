import { describe, expect, it } from 'vitest';
import type { BackupEntry } from './BackupPort.js';
import { DEFAULT_RETENTION, planRetention, retentionFromEnvironment } from './retention.js';

/**
 * A retenção apaga segredo de disco, então as bordas importam.
 *
 * `./.backups/` é o único lugar do desenho que guarda em texto claro o que o SSM
 * guarda cifrado. Sem poda, cada save de um `SecureString` deixa mais uma cópia
 * permanente — e com poda errada, apaga a única que existia.
 */

const NOW = new Date('2026-07-29T12:00:00Z');

function entry(savedAt: string): BackupEntry {
  return { savedAt, version: 1, absolutePath: `/tmp/${savedAt}.json` };
}

/** `days` dias antes de `NOW`. */
function daysAgo(days: number): BackupEntry {
  return entry(new Date(NOW.getTime() - days * 24 * 60 * 60 * 1000).toISOString());
}

function plan(entries: readonly BackupEntry[], limits = DEFAULT_RETENTION) {
  const result = planRetention(entries, limits, NOW);

  return {
    keep: result.keep.map((item) => item.savedAt),
    prune: result.prune.map((item) => item.savedAt),
  };
}

describe('poda por quantidade', () => {
  it('mantém os N mais recentes', () => {
    const entries = [daysAgo(1), daysAgo(2), daysAgo(3), daysAgo(4)];

    const result = plan(entries, { maxAgeDays: undefined, maxVersions: 2 });

    expect(result.keep).toEqual([entries[0]?.savedAt, entries[1]?.savedAt]);
    expect(result.prune).toEqual([entries[2]?.savedAt, entries[3]?.savedAt]);
  });

  it('não poda quando está dentro do limite', () => {
    expect(plan([daysAgo(1), daysAgo(2)], { maxAgeDays: undefined, maxVersions: 5 }).prune).toEqual(
      [],
    );
  });

  it('ordena por instante, não pela ordem em que a lista chegou', () => {
    const older = daysAgo(10);
    const newer = daysAgo(1);

    const result = plan([older, newer], { maxAgeDays: undefined, maxVersions: 1 });

    expect(result.keep).toEqual([newer.savedAt]);
    expect(result.prune).toEqual([older.savedAt]);
  });
});

describe('poda por idade', () => {
  it('apaga o que passou do limite', () => {
    const result = plan([daysAgo(1), daysAgo(100)], { maxAgeDays: 90, maxVersions: undefined });

    expect(result.prune).toHaveLength(1);
    expect(result.keep).toHaveLength(1);
  });

  it('mantém o que está dentro do limite', () => {
    expect(
      plan([daysAgo(1), daysAgo(89)], { maxAgeDays: 90, maxVersions: undefined }).prune,
    ).toEqual([]);
  });
});

describe('o mais recente nunca é apagado', () => {
  it('mesmo velho além do limite de idade', () => {
    // A regra que protege de um BACKUP_MAX_AGE_DAYS=1 esquecido no .env: a poda
    // roda justamente quando a versão anterior está sendo sobrescrita, e apagar
    // a única cópia ali seria perder a versão para sempre.
    const only = daysAgo(400);

    const result = plan([only], { maxAgeDays: 1, maxVersions: undefined });

    expect(result.keep).toEqual([only.savedAt]);
    expect(result.prune).toEqual([]);
  });

  it('mesmo com maxVersions em 1 e tudo velho', () => {
    const entries = [daysAgo(400), daysAgo(500)];

    const result = plan(entries, { maxAgeDays: 1, maxVersions: 1 });

    expect(result.keep).toHaveLength(1);
    expect(result.keep).toEqual([entries[0]?.savedAt]);
  });

  it('lista vazia não quebra', () => {
    expect(plan([])).toEqual({ keep: [], prune: [] });
  });
});

describe('limites desligados', () => {
  it('sem nenhum limite, nada é podado', () => {
    const entries = [daysAgo(1), daysAgo(1000), daysAgo(5000)];

    expect(plan(entries, { maxAgeDays: undefined, maxVersions: undefined }).prune).toEqual([]);
  });
});

describe('timestamp ilegível', () => {
  it('é podado, porque não dá para julgar a idade', () => {
    // Manter indefinidamente um arquivo com segredo é o lado errado da dúvida.
    const result = plan([daysAgo(1), entry('nao-e-data')], {
      maxAgeDays: 90,
      maxVersions: undefined,
    });

    expect(result.prune).toEqual(['nao-e-data']);
  });

  it('mas não se for o mais recente da lista', () => {
    const result = plan([entry('nao-e-data')], { maxAgeDays: 90, maxVersions: undefined });

    expect(result.prune).toEqual([]);
  });
});

describe('retentionFromEnvironment', () => {
  it('usa os padrões quando não há variável', () => {
    expect(retentionFromEnvironment({})).toEqual(DEFAULT_RETENTION);
  });

  it('lê as duas variáveis', () => {
    expect(
      retentionFromEnvironment({
        BACKUP_MAX_AGE_DAYS: '30',
        BACKUP_MAX_VERSIONS_PER_PARAMETER: '5',
      }),
    ).toEqual({ maxAgeDays: 30, maxVersions: 5 });
  });

  it('zero DESLIGA a dimensão, em vez de podar tudo', () => {
    // Desligar por engano é recuperável; apagar não.
    expect(retentionFromEnvironment({ BACKUP_MAX_AGE_DAYS: '0' }).maxAgeDays).toBeUndefined();
    expect(
      retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: '-3' }).maxVersions,
    ).toBeUndefined();
  });

  it('valor inválido cai no padrão', () => {
    for (const raw of ['abc', '1.5', '', '   ']) {
      expect(retentionFromEnvironment({ BACKUP_MAX_AGE_DAYS: raw }).maxAgeDays).toBe(
        DEFAULT_RETENTION.maxAgeDays,
      );
    }
  });
});
