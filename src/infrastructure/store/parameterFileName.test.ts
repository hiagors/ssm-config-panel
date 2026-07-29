import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { InvalidParameterNameError, ParameterNameCollisionError } from '../../domain/errors.js';
import {
  isMetaFile,
  isValueFile,
  parameterNameToMetaPath,
  parameterNameToValuePath,
  resolveExactCasePath,
  valuePathToParameterName,
} from './parameterFileName.js';

const created: string[] = [];

async function makeStore(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'ssm-codec-'));
  created.push(dir);
  return dir;
}

afterEach(() => {
  created.length = 0;
});

describe('codec name <-> caminho', () => {
  it('espelha a hierarquia em diretórios', () => {
    expect(parameterNameToValuePath('/prod/billing/env')).toBe('prod/billing/env.json');
    expect(parameterNameToMetaPath('/prod/billing/env')).toBe('prod/billing/env.meta.json');
  });

  it('faz round-trip preservando o name', () => {
    const names = [
      '/env',
      '/prod/env',
      '/prod/billing/env',
      '/Prod/Billing/Env',
      '/prod/my-app_v1.2/env',
      `/${Array.from({ length: 15 }, (_, i) => `n${i}`).join('/')}`,
    ];

    for (const name of names) {
      expect(valuePathToParameterName(parameterNameToValuePath(name))).toBe(name);
    }
  });

  it('rejeita name terminado em .meta, que colidiria com o sidecar', () => {
    // `/prod/env.meta` viraria `prod/env.meta.json`, indistinguível do
    // sidecar de `/prod/env`.
    expect(() => parameterNameToValuePath('/prod/env.meta')).toThrow(InvalidParameterNameError);
    expect(() => parameterNameToValuePath('/prod/env.META')).toThrow(InvalidParameterNameError);
  });
});

describe('classificação de arquivo', () => {
  it('distingue valor de sidecar', () => {
    expect(isValueFile('prod/env.json')).toBe(true);
    expect(isValueFile('prod/env.meta.json')).toBe(false);
    expect(isMetaFile('prod/env.meta.json')).toBe(true);
    expect(isMetaFile('prod/env.json')).toBe(false);
  });

  it('ignora o que não é .json', () => {
    expect(isValueFile('prod/env.txt')).toBe(false);
    expect(valuePathToParameterName('prod/env.txt')).toBeNull();
  });

  it('devolve null para sidecar, para o list() poder filtrar', () => {
    expect(valuePathToParameterName('prod/env.meta.json')).toBeNull();
  });

  it('devolve null para arquivo cujo caminho não é name válido', () => {
    expect(valuePathToParameterName('prod/my env.json')).toBeNull();
  });
});

describe('resolveExactCasePath — colisão de caixa no APFS', () => {
  it('resolve quando a caixa bate exatamente', async () => {
    const root = await makeStore();
    await mkdir(join(root, 'prod'), { recursive: true });
    await writeFile(join(root, 'prod', 'env.json'), '{}');

    const result = await resolveExactCasePath(root, '/prod/env', 'prod/env.json');

    expect(result.exists).toBe(true);
    expect(result.path).toBe(join(root, 'prod', 'env.json'));
  });

  it('falha alto quando só o arquivo difere na caixa', async () => {
    const root = await makeStore();
    await mkdir(join(root, 'prod'), { recursive: true });
    await writeFile(join(root, 'prod', 'env.json'), '{"real": true}');

    // Em APFS case-insensitive, um readFile de prod/ENV.json abriria o
    // arquivo acima sem erro e devolveria o parâmetro errado.
    await expect(
      resolveExactCasePath(root, '/prod/ENV', 'prod/ENV.json'),
    ).rejects.toThrow(ParameterNameCollisionError);
  });

  it('falha alto quando só o diretório difere na caixa', async () => {
    const root = await makeStore();
    await mkdir(join(root, 'prod'), { recursive: true });
    await writeFile(join(root, 'prod', 'env.json'), '{}');

    await expect(
      resolveExactCasePath(root, '/PROD/env', 'PROD/env.json'),
    ).rejects.toThrow(ParameterNameCollisionError);
  });

  it('a mensagem de colisão nomeia os dois lados', async () => {
    const root = await makeStore();
    await mkdir(join(root, 'prod'), { recursive: true });
    await writeFile(join(root, 'prod', 'env.json'), '{}');

    await expect(
      resolveExactCasePath(root, '/prod/ENV', 'prod/ENV.json'),
    ).rejects.toThrow(/\/prod\/ENV.*\/prod\/env/s);
  });

  it('a mensagem diz quando a colisão é em diretório, não no parâmetro', async () => {
    const root = await makeStore();
    await mkdir(join(root, 'example', 'demo'), { recursive: true });
    await writeFile(join(root, 'example', 'demo', 'env.json'), '{}');

    await expect(
      resolveExactCasePath(root, '/EXAMPLE/demo/env', 'EXAMPLE/demo/env.json'),
    ).rejects.toThrow(/prefixo "\/example"/);
  });

  it('não confunde nomes que apenas compartilham prefixo', async () => {
    const root = await makeStore();
    await mkdir(join(root, 'prod'), { recursive: true });
    await writeFile(join(root, 'prod', 'env.json'), '{}');

    const result = await resolveExactCasePath(root, '/prod/environment', 'prod/environment.json');

    expect(result.exists).toBe(false);
  });

  it('caminho livre devolve exists=false sem lançar', async () => {
    const root = await makeStore();

    const result = await resolveExactCasePath(root, '/novo/env', 'novo/env.json');

    expect(result.exists).toBe(false);
    expect(result.path).toBe(join(root, 'novo', 'env.json'));
  });

  it('store inexistente devolve exists=false sem lançar', async () => {
    const result = await resolveExactCasePath(
      join(tmpdir(), 'ssm-store-que-nao-existe-9f3a'),
      '/prod/env',
      'prod/env.json',
    );

    expect(result.exists).toBe(false);
  });
});
