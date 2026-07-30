import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ParameterMetadata } from '../../domain/Parameter.js';
import { ParameterNameCollisionError } from '../../domain/errors.js';
import { LocalFileBackupAdapter, fileNameFor, savedAtFrom } from './LocalFileBackupAdapter.js';
import type { BackupFileContents } from './BackupPort.js';

/**
 * O backup é a rede de proteção da gravação, e o arquivo dele contém segredo em
 * texto claro. Dois eixos de teste, portanto: que a cópia realmente existe e é
 * completa o bastante para rollback, e que ela nasce com permissão restrita.
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

async function makeAdapter(
  limits = { maxAgeDays: 90 as number | undefined, maxVersions: 20 as number | undefined },
  clock?: () => Date,
) {
  const root = await mkdtemp(join(tmpdir(), 'backups-'));

  return {
    root,
    adapter: new LocalFileBackupAdapter(root, limits, clock ?? (() => new Date())),
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
    let tick = 0;
    const { adapter } = await makeAdapter(undefined, () => {
      tick += 1;
      return new Date(`2026-07-29T12:00:0${tick}.000Z`);
    });

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });

    expect(await adapter.list('/prod/billing/env')).toHaveLength(2);
  });

  it('lista do mais recente para o mais antigo', async () => {
    let tick = 0;
    const { adapter } = await makeAdapter(undefined, () => {
      tick += 1;
      return new Date(`2026-07-29T12:00:0${tick}.000Z`);
    });

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });

    const entries = await adapter.list('/prod/billing/env');

    expect(entries[0]?.savedAt).toBe('2026-07-29T12:00:02.000Z');
    expect(entries[1]?.savedAt).toBe('2026-07-29T12:00:01.000Z');
  });

  it('parâmetro sem backup devolve lista vazia', async () => {
    const { adapter } = await makeAdapter();

    expect(await adapter.list('/nunca/salvo')).toEqual([]);
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
    let tick = 0;
    const { adapter } = await makeAdapter(
      { maxAgeDays: undefined, maxVersions: 2 },
      () => {
        tick += 1;
        return new Date(`2026-07-29T12:00:${String(tick).padStart(2, '0')}.000Z`);
      },
    );

    await adapter.save({ metadata: METADATA, value: '{"v":1}' });
    await adapter.save({ metadata: METADATA, value: '{"v":2}' });
    const third = await adapter.save({ metadata: METADATA, value: '{"v":3}' });

    expect(third.pruned).toHaveLength(1);
    expect(await adapter.list('/prod/billing/env')).toHaveLength(2);
  });

  it('sem limites, nada é podado', async () => {
    let tick = 0;
    const { adapter } = await makeAdapter(
      { maxAgeDays: undefined, maxVersions: undefined },
      () => {
        tick += 1;
        return new Date(`2026-07-29T12:00:${String(tick).padStart(2, '0')}.000Z`);
      },
    );

    for (let index = 0; index < 5; index += 1) {
      await adapter.save({ metadata: METADATA, value: '{}' });
    }

    expect(await adapter.list('/prod/billing/env')).toHaveLength(5);
  });

  it('a poda de um parâmetro não toca no outro', async () => {
    let tick = 0;
    const { adapter } = await makeAdapter({ maxAgeDays: undefined, maxVersions: 1 }, () => {
      tick += 1;
      return new Date(`2026-07-29T12:00:${String(tick).padStart(2, '0')}.000Z`);
    });

    await adapter.save({ metadata: METADATA, value: '{}' });
    await adapter.save({ metadata: { ...METADATA, name: '/outro/param' }, value: '{}' });
    await adapter.save({ metadata: METADATA, value: '{}' });

    expect(await adapter.list('/outro/param')).toHaveLength(1);
    expect(await adapter.list('/prod/billing/env')).toHaveLength(1);
  });
});

describe('colisão de caixa no APFS', () => {
  it('recusa quando o diretório existente difere só na caixa', async () => {
    // /prod/env e /Prod/env são parâmetros diferentes no SSM e cairiam no mesmo
    // diretório de backup: um sobrescreveria o histórico do outro em silêncio.
    const { root, adapter } = await makeAdapter();
    await mkdir(join(root, 'prod', 'env'), { recursive: true });

    await expect(
      adapter.save({ metadata: { ...METADATA, name: '/Prod/env' }, value: '{}' }),
    ).rejects.toBeInstanceOf(ParameterNameCollisionError);
  });

  it('a mensagem pública nomeia o conflito', async () => {
    const { root, adapter } = await makeAdapter();
    await mkdir(join(root, 'prod'), { recursive: true });

    await expect(
      adapter.save({ metadata: { ...METADATA, name: '/PROD/x' }, value: '{}' }),
    ).rejects.toMatchObject({
      code: 'PARAMETER_NAME_COLLISION',
      publicMessage: expect.stringContaining('/prod'),
    });
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
