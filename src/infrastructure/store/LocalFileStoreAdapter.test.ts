import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ParameterNameCollisionError, ParameterNotFoundError } from '../../domain/errors.js';
import { LocalFileStoreAdapter } from './LocalFileStoreAdapter.js';

async function makeAdapter(): Promise<{ adapter: LocalFileStoreAdapter; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'ssm-store-'));
  return { adapter: new LocalFileStoreAdapter(root), root };
}

describe('LocalFileStoreAdapter — get', () => {
  it('lê o valor exatamente como está no arquivo', async () => {
    const { adapter, root } = await makeAdapter();
    const raw = '{\n  "b": 1,\n  "a": 2\n}\n';
    await mkdir(join(root, 'example'), { recursive: true });
    await writeFile(join(root, 'example', 'demo.json'), raw);

    const parameter = await adapter.get('/example/demo');

    // Byte a byte: a ordem das chaves e o espaçamento precisam sobreviver.
    expect(parameter.value).toBe(raw);
  });

  it('lança ParameterNotFoundError quando não existe', async () => {
    const { adapter } = await makeAdapter();

    await expect(adapter.get('/example/ausente')).rejects.toThrow(ParameterNotFoundError);
  });

  it('assume defaults do SSM sem o sidecar', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(join(root, 'demo.json'), '{}');

    const { metadata } = await adapter.get('/demo');

    expect(metadata.type).toBe('String');
    expect(metadata.tier).toBe('Standard');
    expect(metadata.version).toBe(1);
  });

  it('respeita o sidecar de metadados', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(join(root, 'demo.json'), '{}');
    await writeFile(
      join(root, 'demo.meta.json'),
      JSON.stringify({
        type: 'SecureString',
        tier: 'Advanced',
        keyId: 'alias/aws/ssm',
        version: 7,
      }),
    );

    const { metadata } = await adapter.get('/demo');

    expect(metadata.type).toBe('SecureString');
    expect(metadata.tier).toBe('Advanced');
    expect(metadata.keyId).toBe('alias/aws/ssm');
    expect(metadata.version).toBe(7);
  });

  it('ignora campo inválido no sidecar em vez de quebrar', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(join(root, 'demo.json'), '{}');
    await writeFile(join(root, 'demo.meta.json'), JSON.stringify({ type: 'Nonsense', version: -3 }));

    const { metadata } = await adapter.get('/demo');

    expect(metadata.type).toBe('String');
    expect(metadata.version).toBe(1);
  });

  it('erro de sidecar corrompido não expõe o conteúdo do arquivo', async () => {
    const { adapter, root } = await makeAdapter();
    const sentinel = 'SENTINEL-no-sidecar-4d1c';
    await writeFile(join(root, 'demo.json'), '{}');
    await writeFile(join(root, 'demo.meta.json'), `{"keyId": "${sentinel}"`);

    await expect(adapter.get('/demo')).rejects.toThrow(
      expect.objectContaining({
        publicMessage: expect.not.stringContaining(sentinel) as unknown as string,
      }),
    );
  });
});

describe('LocalFileStoreAdapter — put', () => {
  it('grava o valor sem envelope e cria o sidecar ao lado', async () => {
    const { adapter, root } = await makeAdapter();
    const value = '{"a":1}';

    const result = await adapter.put('/example/demo/env', value, {
      type: 'String',
      tier: 'Standard',
    });

    expect(result.version).toBe(1);
    expect(await readFile(join(root, 'example', 'demo', 'env.json'), 'utf8')).toBe(value);

    const meta = JSON.parse(
      await readFile(join(root, 'example', 'demo', 'env.meta.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(meta['type']).toBe('String');
    expect(meta['version']).toBe(1);
  });

  it('cria arquivos com permissão 0600', async () => {
    const { adapter, root } = await makeAdapter();

    await adapter.put('/example/demo', '{}', { type: 'SecureString', tier: 'Standard', keyId: 'alias/aws/ssm' });

    const valueMode = (await stat(join(root, 'example', 'demo.json'))).mode & 0o777;
    const metaMode = (await stat(join(root, 'example', 'demo.meta.json'))).mode & 0o777;

    expect(valueMode).toBe(0o600);
    expect(metaMode).toBe(0o600);
  });

  it('cria diretórios com permissão 0700', async () => {
    const { adapter, root } = await makeAdapter();

    await adapter.put('/example/demo', '{}', { type: 'String', tier: 'Standard' });

    const dirMode = (await stat(join(root, 'example'))).mode & 0o777;

    expect(dirMode).toBe(0o700);
  });

  it('incrementa a versão a cada gravação', async () => {
    const { adapter } = await makeAdapter();

    expect((await adapter.put('/demo', '{"v":1}', { type: 'String', tier: 'Standard' })).version).toBe(1);
    expect((await adapter.put('/demo', '{"v":2}', { type: 'String', tier: 'Standard' })).version).toBe(2);
    expect((await adapter.get('/demo')).value).toBe('{"v":2}');
  });

  it('preserva keyId apenas em SecureString', async () => {
    const { adapter } = await makeAdapter();

    await adapter.put('/secreto', '{}', {
      type: 'SecureString',
      tier: 'Standard',
      keyId: 'alias/minha-chave',
    });
    await adapter.put('/comum', '{}', {
      type: 'String',
      tier: 'Standard',
      keyId: 'alias/minha-chave',
    });

    expect((await adapter.get('/secreto')).metadata.keyId).toBe('alias/minha-chave');
    expect((await adapter.get('/comum')).metadata.keyId).toBeUndefined();
  });

  it('não deixa arquivo temporário para trás', async () => {
    const { adapter } = await makeAdapter();

    await adapter.put('/demo', '{}', { type: 'String', tier: 'Standard' });

    expect(await adapter.list()).toHaveLength(1);
  });
});

describe('LocalFileStoreAdapter — list', () => {
  it('exclui sidecars .meta.json', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/example/a', '{}', { type: 'String', tier: 'Standard' });
    await adapter.put('/example/b', '{}', { type: 'String', tier: 'Standard' });

    const names = (await adapter.list()).map((m) => m.name);

    // Dois parâmetros geram quatro arquivos; só dois são parâmetros.
    expect(names).toEqual(['/example/a', '/example/b']);
  });

  it('ignora arquivo que não é .json', async () => {
    const { adapter, root } = await makeAdapter();
    await writeFile(join(root, 'README.txt'), 'anotação');
    await adapter.put('/demo', '{}', { type: 'String', tier: 'Standard' });

    expect((await adapter.list()).map((m) => m.name)).toEqual(['/demo']);
  });

  it('desce a hierarquia recursivamente', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/a/b/c/d', '{}', { type: 'String', tier: 'Standard' });

    expect((await adapter.list()).map((m) => m.name)).toEqual(['/a/b/c/d']);
  });

  it('filtra por prefixo de path', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{}', { type: 'String', tier: 'Standard' });
    await adapter.put('/staging/env', '{}', { type: 'String', tier: 'Standard' });

    const names = (await adapter.list({ pathPrefix: '/prod' })).map((m) => m.name);

    expect(names).toEqual(['/prod/env']);
  });

  it('com recursive=false não desce além de um nível', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{}', { type: 'String', tier: 'Standard' });
    await adapter.put('/prod/billing/env', '{}', { type: 'String', tier: 'Standard' });

    const names = (await adapter.list({ pathPrefix: '/prod', recursive: false })).map((m) => m.name);

    expect(names).toEqual(['/prod/env']);
  });

  it('store inexistente devolve lista vazia', async () => {
    const adapter = new LocalFileStoreAdapter(join(tmpdir(), 'ssm-store-inexistente-7a2e'));

    expect(await adapter.list()).toEqual([]);
  });

  it('não carrega valor nenhum', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/demo', '{"segredo":"nao-deve-vazar"}', { type: 'String', tier: 'Standard' });

    const listed = await adapter.list();

    expect(JSON.stringify(listed)).not.toContain('nao-deve-vazar');
  });
});

describe('LocalFileStoreAdapter — colisão de caixa', () => {
  it('get com caixa diferente falha em vez de devolver o parâmetro errado', async () => {
    const { adapter } = await makeAdapter();
    await adapter.put('/prod/env', '{"correto":true}', { type: 'String', tier: 'Standard' });

    await expect(adapter.get('/prod/ENV')).rejects.toThrow(ParameterNameCollisionError);
  });

  it('put com caixa diferente falha em vez de sobrescrever', async () => {
    const { adapter, root } = await makeAdapter();
    await adapter.put('/prod/env', '{"original":true}', { type: 'String', tier: 'Standard' });

    await expect(
      adapter.put('/prod/ENV', '{"invasor":true}', { type: 'String', tier: 'Standard' }),
    ).rejects.toThrow(ParameterNameCollisionError);

    // O original tem de continuar intacto.
    expect(await readFile(join(root, 'prod', 'env.json'), 'utf8')).toBe('{"original":true}');
  });
});

describe('LocalFileStoreAdapter — round-trip', () => {
  it('put seguido de get devolve exatamente o mesmo texto', async () => {
    const { adapter } = await makeAdapter();
    // Casos que o serializador da Fase 2 precisa preservar: ordem das
    // chaves, int vs float, null vs string vazia, array heterogêneo.
    const value = JSON.stringify(
      {
        z_primeira: 'ordem preservada',
        inteiro: 42,
        flutuante: 42.0,
        flutuante_real: 3.14,
        verdadeiro: true,
        nulo: null,
        vazio: '',
        aninhado: { nivel2: { nivel3: [1, 'dois', false, null, { k: 'v' }] } },
      },
      null,
      2,
    );

    await adapter.put('/example/roundtrip', value, { type: 'String', tier: 'Standard' });

    expect((await adapter.get('/example/roundtrip')).value).toBe(value);
  });

  it('preserva a diferença entre null e string vazia', async () => {
    const { adapter } = await makeAdapter();
    const value = '{"a":null,"b":""}';

    await adapter.put('/example/nulos', value, { type: 'String', tier: 'Standard' });
    const parsed = JSON.parse((await adapter.get('/example/nulos')).value) as Record<string, unknown>;

    expect(parsed['a']).toBeNull();
    expect(parsed['b']).toBe('');
  });

  it('preserva texto que não é JSON', async () => {
    const { adapter } = await makeAdapter();
    const value = 'isto nao e json { mesmo';

    await adapter.put('/example/cru', value, { type: 'String', tier: 'Standard' });

    expect((await adapter.get('/example/cru')).value).toBe(value);
  });
});
