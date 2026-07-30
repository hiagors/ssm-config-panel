import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParameterMetadata } from '../../domain/Parameter.js';
import { BackupNotFoundError } from '../../domain/errors.js';
import { LocalFileBackupAdapter, fileNameFor, savedAtFrom } from './LocalFileBackupAdapter.js';
import type { BackupFileContents } from './BackupPort.js';
import type { RetentionLimit } from './retention.js';

/**
 * O backup é a rede de proteção da gravação **e** a origem do rollback, e o
 * arquivo dele contém segredo em texto claro. Três eixos de teste, portanto: que
 * a cópia existe e é completa o bastante para restaurar, que ela pode ser lida de
 * volta, e que nasce com permissão restrita.
 */

const METADATA: ParameterMetadata = {
  name: '/prod/billing/env',
  type: 'SecureString',
  tier: 'Advanced',
  keyId: 'alias/minha-chave',
  version: 7,
  lastModifiedAt: '2026-07-28T10:00:00Z',
  description: 'descrição',
};

async function makeAdapter(maxVersions: RetentionLimit = 20, clock?: () => Date) {
  const root = await mkdtemp(join(tmpdir(), 'backups-'));

  return {
    root,
    adapter: new LocalFileBackupAdapter(root, maxVersions, clock ?? (() => new Date())),
  };
}

/** Relógio que avança um segundo por chamada, para timestamps distintos. */
function tickingClock(): () => Date {
  let tick = 0;

  return () => {
    tick += 1;
    return new Date(`2026-07-29T12:00:${String(tick).padStart(2, '0')}.000Z`);
  };
}

describe('save — o arquivo e o layout', () => {
  it('grava em .backups/<name como diretórios>/<timestamp>.json', async () => {
    const { root, adapter } = await makeAdapter();

    const result = await adapter.save({ metadata: METADATA, value: '{"a":1}' });

    expect(result.entry.absolutePath.startsWith(join(root, 'prod', 'billing', 'env'))).toBe(true);
    expect(result.entry.absolutePath.endsWith('.json')).toBe(true);
  });

  it('preserva os metadados necessários para rollback, não só o valor', async () => {
    // Um backup com o valor cru não serve: sem versão, Type, Tier e KeyId não há
    // como regravar.
    const { adapter } = await makeAdapter();

    const result = await adapter.save({ metadata: METADATA, value: '{"a":1}' });
    const contents = JSON.parse(
      await readFile(result.entry.absolutePath, 'utf8'),
    ) as BackupFileContents;

    expect(contents).toMatchObject({
      name: '/prod/billing/env',
      version: 7,
      type: 'SecureString',
      tier: 'Advanced',
      keyId: 'alias/minha-chave',
      value: '{"a":1}',
    });
  });

  it('grava o valor byte a byte, sem reformatar', async () => {
    const { adapter } = await makeAdapter();
    const value = '{\n  "a": 30.0,\n  "b": {  "x":1  }\n}';

    const result = await adapter.save({ metadata: METADATA, value });
    const contents = JSON.parse(
      await readFile(result.entry.absolutePath, 'utf8'),
    ) as BackupFileContents;

    expect(contents.value).toBe(value);
  });

  it('keyId ausente vira null explícito', async () => {
    const { adapter } = await makeAdapter();

    const result = await adapter.save({
      metadata: { ...METADATA, type: 'String', keyId: undefined },
      value: '{}',
    });
    const contents = JSON.parse(
      await readFile(result.entry.absolutePath, 'utf8'),
    ) as BackupFileContents;

    expect(contents.keyId).toBeNull();
  });

  it('dois saves do mesmo parâmetro convivem', async () => {
    const { adapter } = await makeAdapter(20, tickingClock());

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });

    expect(await adapter.list('/prod/billing/env')).toHaveLength(2);
  });
});

describe('list — o que a tela de rollback mostra', () => {
  it('lista do mais recente para o mais antigo', async () => {
    const { adapter } = await makeAdapter(20, tickingClock());

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });

    const entries = await adapter.list('/prod/billing/env');

    expect(entries[0]?.savedAt).toBe('2026-07-29T12:00:02.000Z');
    expect(entries[1]?.savedAt).toBe('2026-07-29T12:00:01.000Z');
  });

  it('devolve a versão real do parâmetro, não um placeholder', async () => {
    // É a versão que responde "restaurar isto me leva de volta a quê".
    const { adapter } = await makeAdapter(20, tickingClock());

    await adapter.save({ metadata: { ...METADATA, version: 3 }, value: '{"v":3}' });
    await adapter.save({ metadata: { ...METADATA, version: 4 }, value: '{"v":4}' });

    expect((await adapter.list('/prod/billing/env')).map((entry) => entry.version)).toEqual([4, 3]);
  });

  it('parâmetro sem backup devolve lista vazia', async () => {
    const { adapter } = await makeAdapter();

    expect(await adapter.list('/nunca/salvo')).toEqual([]);
  });

  it('não devolve valor nenhum: só o que a lista precisa', async () => {
    const { adapter } = await makeAdapter();
    await adapter.save({ metadata: METADATA, value: '{"segredo":"nao-deve-vazar"}' });

    expect(JSON.stringify(await adapter.list('/prod/billing/env'))).not.toContain(
      'nao-deve-vazar',
    );
  });

  it('arquivo corrompido é omitido em vez de quebrar a listagem', async () => {
    const { root, adapter } = await makeAdapter();
    await adapter.save({ metadata: METADATA, value: '{"bom":true}' });
    await writeFile(
      join(root, 'prod', 'billing', 'env', '2026-01-01T00-00-00.000Z.json'),
      '{"name": "/prod/billing/env"',
    );

    expect(await adapter.list('/prod/billing/env')).toHaveLength(1);
  });
});

describe('read — carregar um backup para restaurar', () => {
  it('devolve o envelope completo do backup escolhido', async () => {
    const { adapter } = await makeAdapter(20, tickingClock());

    await adapter.save({ metadata: { ...METADATA, version: 6 }, value: '{"v":6}' });
    await adapter.save({ metadata: { ...METADATA, version: 7 }, value: '{"v":7}' });

    const contents = await adapter.read('/prod/billing/env', '2026-07-29T12:00:01.000Z');

    expect(contents.version).toBe(6);
    expect(contents.value).toBe('{"v":6}');
    expect(contents.type).toBe('SecureString');
    expect(contents.keyId).toBe('alias/minha-chave');
  });

  it('backup inexistente lança BackupNotFoundError', async () => {
    const { adapter } = await makeAdapter();

    await expect(
      adapter.read('/prod/billing/env', '2020-01-01T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(BackupNotFoundError);
  });

  it('backup podado depois de listado lança BackupNotFoundError, não erro genérico', async () => {
    // O caso real: a retenção apagou o arquivo entre a listagem e o clique.
    const { adapter } = await makeAdapter(1, tickingClock());

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    const antigo = '2026-07-29T12:00:01.000Z';
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });

    await expect(adapter.read('/prod/billing/env', antigo)).rejects.toMatchObject({
      code: 'BACKUP_NOT_FOUND',
      httpStatus: 404,
    });
  });

  it('a mensagem de ausência não expõe conteúdo, só name e data', async () => {
    const { adapter } = await makeAdapter();

    await expect(adapter.read('/prod/billing/env', '2020-01-01T00:00:00.000Z')).rejects.toMatchObject(
      { publicMessage: expect.stringContaining('/prod/billing/env') },
    );
  });
});

describe('save — permissões', () => {
  it('arquivo nasce com 0600', async () => {
    // Contém SecureString decriptado.
    const { adapter } = await makeAdapter();

    const result = await adapter.save({ metadata: METADATA, value: '{}' });

    expect((await stat(result.entry.absolutePath)).mode & 0o777).toBe(0o600);
  });

  it('diretórios nascem com 0700', async () => {
    const { root, adapter } = await makeAdapter();

    await adapter.save({ metadata: METADATA, value: '{}' });

    for (const path of [
      join(root, 'prod'),
      join(root, 'prod', 'billing'),
      join(root, 'prod', 'billing', 'env'),
    ]) {
      expect((await stat(path)).mode & 0o777).toBe(0o700);
    }
  });

  it('não deixa arquivo temporário para trás', async () => {
    const { root, adapter } = await makeAdapter();

    await adapter.save({ metadata: METADATA, value: '{}' });

    const files = await readdir(join(root, 'prod', 'billing', 'env'));

    expect(files.some((file) => file.includes('.tmp-'))).toBe(false);
  });
});

describe('retenção aplicada na gravação', () => {
  it('poda o excedente e informa o que apagou', async () => {
    const { adapter } = await makeAdapter(2, tickingClock());

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });
    const third = await adapter.save({ metadata: METADATA, value: '{"v":3}' });

    expect(third.pruned).toHaveLength(1);
    expect(await adapter.list('/prod/billing/env')).toHaveLength(2);
  });

  it('sem limite, nada é podado', async () => {
    const { adapter } = await makeAdapter(undefined, tickingClock());

    for (let index = 0; index < 5; index += 1) {
      await adapter.save({ metadata: METADATA, value: '{}' });
    }

    expect(await adapter.list('/prod/billing/env')).toHaveLength(5);
  });

  it('a poda de um parâmetro não toca no outro', async () => {
    const { adapter } = await makeAdapter(1, tickingClock());

    await adapter.save({ metadata: METADATA, value: '{}' });
    await adapter.save({ metadata: { ...METADATA, name: '/outro/param' }, value: '{}' });
    await adapter.save({ metadata: METADATA, value: '{}' });

    expect(await adapter.list('/outro/param')).toHaveLength(1);
    expect(await adapter.list('/prod/billing/env')).toHaveLength(1);
  });
});

describe('colisão de caixa no APFS', () => {
  /**
   * `/prod/env` e `/Prod/env` são parâmetros diferentes no SSM e caem no mesmo
   * diretório em APFS case-insensitive. A defesa é o `name` gravado dentro do
   * arquivo: backup de outro parâmetro não aparece na lista e não pode ser lido.
   */
  it('backup de outro parâmetro não aparece na listagem', async () => {
    const { root, adapter } = await makeAdapter();
    await mkdir(join(root, 'prod', 'env'), { recursive: true });
    await writeFile(
      join(root, 'prod', 'env', '2026-07-29T12-00-00.000Z.json'),
      JSON.stringify({ name: '/Prod/env', version: 1, value: '{"outro":true}' }),
    );

    expect(await adapter.list('/prod/env')).toEqual([]);
  });

  it('read recusa arquivo cujo name é de outro parâmetro', async () => {
    const { root, adapter } = await makeAdapter();
    await mkdir(join(root, 'prod', 'env'), { recursive: true });
    await writeFile(
      join(root, 'prod', 'env', '2026-07-29T12-00-00.000Z.json'),
      JSON.stringify({ name: '/Prod/env', version: 1, value: '{"outro":true}' }),
    );

    await expect(adapter.read('/prod/env', '2026-07-29T12:00:00.000Z')).rejects.toBeInstanceOf(
      BackupNotFoundError,
    );
  });
});

describe('nome de arquivo a partir do timestamp', () => {
  it('troca ":" por "-", porque o Finder exibe ":" como "/"', () => {
    expect(fileNameFor('2026-07-29T12:34:56.789Z')).toBe('2026-07-29T12-34-56.789Z');
  });

  it('a volta é determinística', () => {
    const iso = '2026-07-29T12:34:56.789Z';

    expect(savedAtFrom(`${fileNameFor(iso)}.json`)).toBe(iso);
  });

  it('arquivo que não casa o padrão é ignorado na listagem', async () => {
    const { root, adapter } = await makeAdapter();
    await mkdir(join(root, 'prod', 'billing', 'env'), { recursive: true });
    await writeFile(join(root, 'prod', 'billing', 'env', 'anotacao.json'), '{}');

    expect(await adapter.list('/prod/billing/env')).toEqual([]);
  });
});
