import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  SECRET_TOKEN_FIELDS,
  cacheFileNameFor,
  readSessionState,
  ssoCacheDirectory,
} from './ssoTokenCache.js';

/**
 * O cache de token do SSO é lido, não adivinhado.
 *
 * Ler o arquivo — em vez de tentar obter credenciais e ver se dá erro — é o que
 * distingue *expirada* de *nunca autenticada*. Uma tentativa de credencial
 * colapsaria os dois no mesmo "não funcionou", e a UI precisa dizer coisas
 * diferentes: reautenticar versus autenticar pela primeira vez.
 */

const NOW = new Date('2026-07-29T12:00:00Z');

async function makeCache(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'sso-cache-'));
}

async function writeToken(
  directory: string,
  fileName: string,
  token: Record<string, unknown>,
): Promise<void> {
  await writeFile(join(directory, fileName), JSON.stringify(token), { mode: 0o600 });
}

describe('cacheFileNameFor', () => {
  it('usa sha1 hexadecimal, o esquema do AWS CLI', () => {
    // Verificado contra a máquina real: sha1('hiago-sso-appmax') é o nome de um
    // dos arquivos em ~/.aws/sso/cache.
    expect(cacheFileNameFor('hiago-sso-appmax')).toBe(
      'a591fef26822426fbdd828b7f63d3c19fece42b9.json',
    );
  });

  it('nomes diferentes dão arquivos diferentes', () => {
    expect(cacheFileNameFor('a')).not.toBe(cacheFileNameFor('b'));
  });
});

describe('readSessionState — formato novo, por nome de sso-session', () => {
  it('token no futuro é sessão válida', async () => {
    const directory = await makeCache();
    await writeToken(directory, cacheFileNameFor('minha-sessao'), {
      startUrl: 'https://exemplo.awsapps.com/start',
      accessToken: 'nao-deve-ser-lido',
      expiresAt: '2026-07-29T18:00:00Z',
    });

    const result = await readSessionState('minha-sessao', undefined, NOW, directory);

    expect(result.state).toBe('valid');
    expect(result.expiresAt).toBe('2026-07-29T18:00:00Z');
  });

  it('token no passado é sessão expirada', async () => {
    const directory = await makeCache();
    await writeToken(directory, cacheFileNameFor('minha-sessao'), {
      startUrl: 'https://exemplo.awsapps.com/start',
      accessToken: 'x',
      expiresAt: '2026-07-29T06:00:00Z',
    });

    expect((await readSessionState('minha-sessao', undefined, NOW, directory)).state).toBe(
      'expired',
    );
  });

  it('sem arquivo é nunca autenticado', async () => {
    const directory = await makeCache();

    expect((await readSessionState('minha-sessao', undefined, NOW, directory)).state).toBe(
      'neverAuthenticated',
    );
  });

  it('diretório inexistente é nunca autenticado, não erro', async () => {
    const result = await readSessionState(
      'x',
      'https://exemplo.awsapps.com/start',
      NOW,
      join(tmpdir(), 'nao-existe-sso-cache-9f2a'),
    );

    expect(result.state).toBe('neverAuthenticated');
  });
});

describe('readSessionState — formato legado, por start URL', () => {
  it('encontra o token varrendo o diretório', async () => {
    // No formato legado a chave do cache é sha1(sso_start_url). Passamos a URL
    // como sessionKey e ela casa direto.
    const directory = await makeCache();
    const startUrl = 'https://legado.awsapps.com/start';

    await writeToken(directory, cacheFileNameFor(startUrl), {
      startUrl,
      accessToken: 'x',
      expiresAt: '2026-07-29T18:00:00Z',
    });

    expect((await readSessionState(startUrl, startUrl, NOW, directory)).state).toBe('valid');
  });

  it('casa por start URL quando o nome do arquivo não é o esperado', async () => {
    // Cobre versão de CLI com outro esquema de nome.
    const directory = await makeCache();
    const startUrl = 'https://legado.awsapps.com/start';

    await writeToken(directory, 'nome-inesperado.json', {
      startUrl,
      accessToken: 'x',
      expiresAt: '2026-07-29T18:00:00Z',
    });

    expect((await readSessionState('sessao-sem-arquivo', startUrl, NOW, directory)).state).toBe(
      'valid',
    );
  });

  it('ignora barra final ao comparar start URL', async () => {
    const directory = await makeCache();

    await writeToken(directory, 'qualquer.json', {
      startUrl: 'https://legado.awsapps.com/start/',
      accessToken: 'x',
      expiresAt: '2026-07-29T18:00:00Z',
    });

    const result = await readSessionState(
      'sem-arquivo',
      'https://legado.awsapps.com/start',
      NOW,
      directory,
    );

    expect(result.state).toBe('valid');
  });
});

describe('readSessionState — desempate entre tokens', () => {
  it('escolhe o de expiração mais distante', async () => {
    // A máquina real tem três tokens para a mesma start URL. Olhar o mais
    // antigo mandaria reautenticar sem motivo.
    const directory = await makeCache();
    const startUrl = 'https://exemplo.awsapps.com/start';

    await writeToken(directory, 'antigo.json', {
      startUrl,
      accessToken: 'x',
      expiresAt: '2024-12-04T18:35:50Z',
    });
    await writeToken(directory, 'novo.json', {
      startUrl,
      accessToken: 'x',
      expiresAt: '2026-07-29T18:00:00Z',
    });

    expect((await readSessionState('sem-arquivo', startUrl, NOW, directory)).state).toBe('valid');
  });
});

describe('readSessionState — arquivos que não são token', () => {
  it('ignora registro de cliente OIDC', async () => {
    // Estes arquivos têm clientId e clientSecret mas nem startUrl nem
    // accessToken. Confundi-los com token reportaria sessão onde não há.
    const directory = await makeCache();

    await writeToken(directory, 'registro.json', {
      clientId: 'abc',
      clientSecret: 'def',
      expiresAt: '2026-10-27T00:47:00Z',
      scopes: ['sso:account:access'],
    });

    const result = await readSessionState(
      'sem-arquivo',
      'https://exemplo.awsapps.com/start',
      NOW,
      directory,
    );

    expect(result.state).toBe('neverAuthenticated');
  });

  it('ignora arquivo que não é JSON', async () => {
    const directory = await makeCache();
    await writeFile(join(directory, 'sujeira.json'), 'nao e json {');

    expect(
      (await readSessionState('x', 'https://exemplo.awsapps.com/start', NOW, directory)).state,
    ).toBe('neverAuthenticated');
  });

  it('trata expiresAt inválido como expirado', async () => {
    // Caminho seguro: força reautenticação em vez de assumir validade.
    const directory = await makeCache();

    await writeToken(directory, cacheFileNameFor('s'), {
      startUrl: 'https://exemplo.awsapps.com/start',
      accessToken: 'x',
      expiresAt: 'data-quebrada',
    });

    expect((await readSessionState('s', undefined, NOW, directory)).state).toBe('expired');
  });

  it('token sem expiresAt conta como nunca autenticado', async () => {
    const directory = await makeCache();

    await writeToken(directory, cacheFileNameFor('s'), {
      startUrl: 'https://exemplo.awsapps.com/start',
      accessToken: 'x',
    });

    expect((await readSessionState('s', undefined, NOW, directory)).state).toBe(
      'neverAuthenticated',
    );
  });
});

describe('readSessionState — nenhum segredo sai', () => {
  it('o resultado não contém accessToken nem clientSecret', async () => {
    const directory = await makeCache();
    const sentinel = 'SENTINEL-token-4b1e-DO-NOT-LEAK';

    await writeToken(directory, cacheFileNameFor('s'), {
      startUrl: 'https://exemplo.awsapps.com/start',
      accessToken: sentinel,
      clientSecret: sentinel,
      refreshToken: sentinel,
      expiresAt: '2026-07-29T18:00:00Z',
    });

    const result = await readSessionState('s', undefined, NOW, directory);

    expect(JSON.stringify(result)).not.toContain(sentinel);
    // O resultado só tem estado e validade.
    expect(Object.keys(result).sort()).toEqual(['expiresAt', 'state']);
  });

  it('nenhum campo secreto é exposto na superfície do módulo', () => {
    expect(SECRET_TOKEN_FIELDS).toEqual(['accessToken', 'clientSecret', 'refreshToken']);
  });
});

describe('ssoCacheDirectory', () => {
  it('aponta para ~/.aws/sso/cache por padrão', () => {
    expect(ssoCacheDirectory({})).toMatch(/\.aws\/sso\/cache$/);
  });

  it('respeita o override de teste', () => {
    expect(ssoCacheDirectory({ AWS_SSO_CACHE_DIR: '/tmp/x' })).toBe('/tmp/x');
  });

  it('ignora override vazio', () => {
    expect(ssoCacheDirectory({ AWS_SSO_CACHE_DIR: '  ' })).toMatch(/\.aws\/sso\/cache$/);
  });
});
