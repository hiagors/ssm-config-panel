import { describe, expect, it } from 'vitest';
import { BackupNotFoundError } from '../domain/errors.js';
import type {
  BackupEntry,
  BackupFileContents,
  BackupInput,
  BackupPort,
  BackupResult,
} from '../infrastructure/backup/BackupPort.js';
import { BackupHistoryUseCase } from './BackupHistoryUseCase.js';

/**
 * O rollback é o único critério do projeto que existia só no disco: o backup era
 * gravado e não havia caminho de volta. Estes testes fixam as duas garantias que
 * fazem o caminho de volta ser seguro:
 *
 * 1. **Listar não carrega valor.** A tela de histórico é datas e versões.
 * 2. **Ler não grava.** Restaurar devolve um rascunho; a gravação é do fluxo
 *    normal, com diff, confirmação e backup da versão atual.
 */

const SAVED_AT = '2026-07-29T12:00:00.000Z';

class FakeBackup implements BackupPort {
  writes = 0;

  /**
   * `files` é indexado pelo timestamp do **nome do arquivo**, como no adapter
   * real — e não pelo campo `savedAt` de dentro do envelope. A diferença importa:
   * envelope antigo pode não ter o campo, e o arquivo continua sendo encontrável.
   */
  constructor(
    private readonly entries: readonly BackupEntry[] = [],
    private readonly files: ReadonlyMap<string, BackupFileContents> = new Map(),
  ) {}

  async save(input: BackupInput): Promise<BackupResult> {
    this.writes += 1;

    return {
      entry: { savedAt: SAVED_AT, version: input.metadata.version, absolutePath: '/tmp/fake' },
      pruned: [],
    };
  }

  async list(): Promise<readonly BackupEntry[]> {
    return this.entries;
  }

  async read(parameterName: string, savedAt: string): Promise<BackupFileContents> {
    const found = this.files.get(savedAt);

    if (found === undefined) {
      throw new BackupNotFoundError(parameterName, savedAt);
    }

    return found;
  }
}

/** Um arquivo de backup, na chave em que o adapter real o encontraria. */
function file(
  savedAt: string,
  version: number,
  value: string,
  overrides: Partial<BackupFileContents> = {},
): ReadonlyMap<string, BackupFileContents> {
  return new Map([[savedAt, { ...contents(savedAt, version, value), ...overrides }]]);
}

function entry(savedAt: string, version: number): BackupEntry {
  return { savedAt, version, absolutePath: `/tmp/${savedAt}.json` };
}

function contents(savedAt: string, version: number, value: string): BackupFileContents {
  return {
    name: '/prod/billing/env',
    version,
    type: 'SecureString',
    tier: 'Advanced',
    keyId: 'alias/minha-chave',
    savedAt,
    value,
  };
}

describe('list', () => {
  it('devolve data e versão de cada backup', async () => {
    const port = new FakeBackup([
      entry('2026-07-29T12:00:02.000Z', 8),
      entry('2026-07-29T12:00:01.000Z', 7),
    ]);

    const result = await new BackupHistoryUseCase(port).list('/prod/billing/env');

    expect(result).toEqual([
      { savedAt: '2026-07-29T12:00:02.000Z', version: 8 },
      { savedAt: '2026-07-29T12:00:01.000Z', version: 7 },
    ]);
  });

  it('não expõe caminho de arquivo nem valor', async () => {
    // O caminho absoluto vaza a estrutura de diretórios do meu disco na página, e
    // o valor pode ser SecureString decriptado. Nem um nem outro têm o que fazer
    // numa lista de datas.
    const port = new FakeBackup([entry(SAVED_AT, 3)]);

    const result = await new BackupHistoryUseCase(port).list('/prod/billing/env');

    expect(JSON.stringify(result)).not.toContain('/tmp/');
    expect(Object.keys(result[0] ?? {}).sort()).toEqual(['savedAt', 'version']);
  });

  it('parâmetro sem backup devolve lista vazia, não erro', async () => {
    expect(await new BackupHistoryUseCase(new FakeBackup()).list('/nunca/salvo')).toEqual([]);
  });

  it('name inválido é recusado antes de tocar no disco', async () => {
    await expect(new BackupHistoryUseCase(new FakeBackup()).list('sem-barra')).rejects.toMatchObject(
      { code: 'INVALID_PARAMETER_NAME' },
    );
  });
});

describe('read', () => {
  it('devolve o valor e a versão de onde ele veio', async () => {
    const port = new FakeBackup([], file(SAVED_AT, 6, '{"antigo":true}'));

    const candidate = await new BackupHistoryUseCase(port).read('/prod/billing/env', SAVED_AT);

    expect(candidate).toEqual({ savedAt: SAVED_AT, version: 6, value: '{"antigo":true}' });
  });

  it('NÃO grava nada: restaurar é carregar rascunho, não escrever', async () => {
    // A garantia central do desenho do rollback. Se ler um backup gravasse,
    // pularia o diff, a confirmação e o backup da versão atual — e o rollback
    // ficaria sem rollback.
    const port = new FakeBackup([], file(SAVED_AT, 6, '{}'));

    await new BackupHistoryUseCase(port).read('/prod/billing/env', SAVED_AT);

    expect(port.writes).toBe(0);
  });

  it('backup ausente propaga BackupNotFoundError', async () => {
    const port = new FakeBackup([], file(SAVED_AT, 6, '{}'));

    await expect(
      new BackupHistoryUseCase(port).read('/prod/billing/env', '2020-01-01T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it('envelope antigo sem savedAt cai no timestamp pedido', async () => {
    // Tolerância a backup gravado por versão anterior da ferramenta: o nome do
    // arquivo sempre teve a data, mesmo quando o campo não existia.
    const port = new FakeBackup([], file(SAVED_AT, 6, '{}', { savedAt: '' }));

    expect((await new BackupHistoryUseCase(port).read('/prod/billing/env', SAVED_AT)).savedAt).toBe(
      SAVED_AT,
    );
  });
});
