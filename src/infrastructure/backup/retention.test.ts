import { describe, expect, it } from 'vitest';
import type { BackupEntry } from './BackupPort.js';
import { DEFAULT_MAX_VERSIONS, planRetention, retentionFromEnvironment } from './retention.js';

/**
 * A retenção apaga segredo de disco, então as bordas importam.
 *
 * `./.backups/` é o único lugar do desenho que guarda em texto claro o que o SSM
 * guarda cifrado. Sem poda, cada save de um `SecureString` deixa mais uma cópia
 * permanente — e com poda errada, apaga a única que existia.
 */

function entry(savedAt: string, version = 1): BackupEntry {
  return { savedAt, version, absolutePath: `/tmp/${savedAt}.json` };
}

describe('planRetention', () => {
  it('lista vazia não produz poda', () => {
    expect(planRetention([], 5)).toEqual({ keep: [], prune: [] });
  });

  it('mantém as N mais recentes e poda o resto', () => {
    const entries = [
      entry('2026-07-01T00:00:00.000Z'),
      entry('2026-07-05T00:00:00.000Z'),
      entry('2026-07-03T00:00:00.000Z'),
      entry('2026-07-02T00:00:00.000Z'),
    ];

    const result = planRetention(entries, 2);

    expect(result.keep.map((item) => item.savedAt)).toEqual([
      '2026-07-05T00:00:00.000Z',
      '2026-07-03T00:00:00.000Z',
    ]);
    expect(result.prune.map((item) => item.savedAt)).toEqual([
      '2026-07-02T00:00:00.000Z',
      '2026-07-01T00:00:00.000Z',
    ]);
  });

  it('ordena cronologicamente, não pela ordem em que os arquivos foram lidos', () => {
    const result = planRetention(
      [entry('2026-01-01T00:00:00.000Z'), entry('2026-12-31T00:00:00.000Z')],
      1,
    );

    expect(result.keep.map((item) => item.savedAt)).toEqual(['2026-12-31T00:00:00.000Z']);
  });

  it('limite maior que a quantidade existente não poda nada', () => {
    const entries = [entry('2026-07-01T00:00:00.000Z'), entry('2026-07-02T00:00:00.000Z')];

    expect(planRetention(entries, 10).prune).toEqual([]);
  });

  it('limite undefined desliga a poda', () => {
    const entries = Array.from({ length: 50 }, (_, index) =>
      entry(`2026-07-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`),
    );

    const result = planRetention(entries, undefined);

    expect(result.prune).toEqual([]);
    expect(result.keep).toHaveLength(50);
  });

  it('o mais recente nunca é podado, nem com limite 1', () => {
    const entries = [entry('2026-07-01T00:00:00.000Z'), entry('2026-07-02T00:00:00.000Z')];

    const result = planRetention(entries, 1);

    expect(result.keep.map((item) => item.savedAt)).toEqual(['2026-07-02T00:00:00.000Z']);
    expect(result.prune).toHaveLength(1);
  });

  it('cópia única nunca é podada', () => {
    const only = [entry('2026-07-01T00:00:00.000Z')];

    expect(planRetention(only, 1).prune).toEqual([]);
    expect(planRetention(only, 1).keep).toHaveLength(1);
  });

  it('não muta a lista recebida', () => {
    const entries = [entry('2026-07-01T00:00:00.000Z'), entry('2026-07-09T00:00:00.000Z')];
    const before = entries.map((item) => item.savedAt);

    planRetention(entries, 1);

    expect(entries.map((item) => item.savedAt)).toEqual(before);
  });
});

describe('retentionFromEnvironment', () => {
  it('ambiente vazio usa o default', () => {
    expect(retentionFromEnvironment({})).toBe(DEFAULT_MAX_VERSIONS);
  });

  it('lê o limite do ambiente', () => {
    expect(retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: '5' })).toBe(5);
  });

  it('0 desliga a poda em vez de apagar tudo', () => {
    expect(retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: '0' })).toBeUndefined();
  });

  it('valor negativo desliga a poda', () => {
    expect(retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: '-1' })).toBeUndefined();
  });

  it('valor não numérico cai no default em vez de desligar em silêncio', () => {
    expect(retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: 'muitos' })).toBe(
      DEFAULT_MAX_VERSIONS,
    );
  });

  it('valor fracionário cai no default', () => {
    expect(retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: '2.5' })).toBe(
      DEFAULT_MAX_VERSIONS,
    );
  });

  it('string vazia cai no default', () => {
    expect(retentionFromEnvironment({ BACKUP_MAX_VERSIONS_PER_PARAMETER: '   ' })).toBe(
      DEFAULT_MAX_VERSIONS,
    );
  });
});
