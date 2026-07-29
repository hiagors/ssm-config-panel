import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProfileNotUsableError } from '../../domain/errors.js';
import { AwsSsoAdapter } from './AwsSsoAdapter.js';
import { cacheFileNameFor } from './ssoTokenCache.js';

/**
 * Classificação de profiles a partir da configuração compartilhada da AWS.
 *
 * Usa fixtures em disco apontadas por `AWS_CONFIG_FILE` e
 * `AWS_SHARED_CREDENTIALS_FILE`, que é o que `loadSharedConfigFiles()` respeita.
 * Assim o teste não depende do `~/.aws` de quem roda.
 *
 * O spec exige cobrir os **dois formatos** de SSO. Os profiles reais desta
 * máquina usam só o novo (`[sso-session]`), então o legado
 * (`sso_start_url` inline) só existe aqui.
 */

const NOW = new Date('2026-07-29T12:00:00Z');
const FUTURE = '2026-07-29T18:00:00Z';
const PAST = '2026-07-29T06:00:00Z';

const originalEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnvironment };
});

interface Fixture {
  readonly config: string;
  readonly credentials?: string;
  readonly tokens?: readonly { readonly key: string; readonly expiresAt: string }[];
}

async function setUp(fixture: Fixture): Promise<AwsSsoAdapter> {
  const directory = await mkdtemp(join(tmpdir(), 'aws-fixture-'));
  const configPath = join(directory, 'config');
  const credentialsPath = join(directory, 'credentials');
  const cacheDirectory = join(directory, 'cache');

  await writeFile(configPath, fixture.config);
  await writeFile(credentialsPath, fixture.credentials ?? '');

  await mkdtemp(cacheDirectory).catch(() => undefined);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(cacheDirectory, { recursive: true });

  for (const token of fixture.tokens ?? []) {
    await writeFile(
      join(cacheDirectory, cacheFileNameFor(token.key)),
      JSON.stringify({
        startUrl: 'https://exemplo.awsapps.com/start',
        region: 'us-east-1',
        accessToken: 'nao-deve-ser-lido',
        expiresAt: token.expiresAt,
      }),
    );
  }

  process.env['AWS_CONFIG_FILE'] = configPath;
  process.env['AWS_SHARED_CREDENTIALS_FILE'] = credentialsPath;

  return new AwsSsoAdapter(cacheDirectory, 1000, () => NOW);
}

describe('formato novo: [sso-session]', () => {
  const CONFIG = `
[profile prod-admin]
sso_session = minha-sessao
sso_account_id = 111122223333
sso_role_name = administrador
region = us-east-1

[sso-session minha-sessao]
sso_start_url = https://exemplo.awsapps.com/start
sso_region = us-east-1
`;

  it('reconhece o profile como SSO e resolve conta e role', async () => {
    const adapter = await setUp({ config: CONFIG, tokens: [{ key: 'minha-sessao', expiresAt: FUTURE }] });

    const profile = (await adapter.listProfiles()).find((item) => item.name === 'prod-admin');

    expect(profile).toMatchObject({
      kind: 'sso',
      accountId: '111122223333',
      roleName: 'administrador',
      region: 'us-east-1',
      ssoStartUrl: 'https://exemplo.awsapps.com/start',
      ssoSessionName: 'minha-sessao',
      selectable: true,
      sessionState: 'valid',
    });
  });

  it('o bloco [sso-session] não aparece como profile selecionável', async () => {
    const adapter = await setUp({ config: CONFIG });

    const names = (await adapter.listProfiles()).map((profile) => profile.name);

    expect(names).toContain('prod-admin');
    expect(names.some((name) => name.includes('sso-session'))).toBe(false);
    expect(names).not.toContain('minha-sessao');
  });

  it('token expirado dá sessão expirada', async () => {
    const adapter = await setUp({ config: CONFIG, tokens: [{ key: 'minha-sessao', expiresAt: PAST }] });

    expect((await adapter.findProfile('prod-admin'))?.sessionState).toBe('expired');
  });

  it('sem token dá nunca autenticado', async () => {
    const adapter = await setUp({ config: CONFIG });

    expect((await adapter.findProfile('prod-admin'))?.sessionState).toBe('neverAuthenticated');
  });

  it('dois profiles na mesma sso-session compartilham o estado', async () => {
    // É o caso real: dois profiles apontando para `hiago-sso-appmax`.
    const adapter = await setUp({
      config: `${CONFIG}
[profile outra-conta]
sso_session = minha-sessao
sso_account_id = 444455556666
sso_role_name = leitor
region = us-east-1
`,
      tokens: [{ key: 'minha-sessao', expiresAt: FUTURE }],
    });

    expect((await adapter.findProfile('prod-admin'))?.sessionState).toBe('valid');
    expect((await adapter.findProfile('outra-conta'))?.sessionState).toBe('valid');
    expect((await adapter.findProfile('outra-conta'))?.accountId).toBe('444455556666');
  });

  it('herda a região da sso-session quando o profile não define', async () => {
    const adapter = await setUp({
      config: `
[profile sem-regiao]
sso_session = minha-sessao
sso_account_id = 111122223333
sso_role_name = admin

[sso-session minha-sessao]
sso_start_url = https://exemplo.awsapps.com/start
sso_region = eu-central-1
`,
    });

    expect((await adapter.findProfile('sem-regiao'))?.region).toBe('eu-central-1');
  });
});

describe('formato legado: sso_start_url inline', () => {
  const LEGACY = `
[profile legado]
sso_start_url = https://exemplo.awsapps.com/start
sso_region = us-east-1
sso_account_id = 777788889999
sso_role_name = legado-role
region = us-east-1
`;

  it('reconhece como SSO sem bloco [sso-session]', async () => {
    const adapter = await setUp({ config: LEGACY });

    expect(await adapter.findProfile('legado')).toMatchObject({
      kind: 'sso',
      accountId: '777788889999',
      roleName: 'legado-role',
      ssoStartUrl: 'https://exemplo.awsapps.com/start',
      ssoSessionName: undefined,
      selectable: true,
    });
  });

  it('resolve o estado da sessão pela start URL', async () => {
    const adapter = await setUp({
      config: LEGACY,
      tokens: [{ key: 'https://exemplo.awsapps.com/start', expiresAt: FUTURE }],
    });

    expect((await adapter.findProfile('legado'))?.sessionState).toBe('valid');
  });

  it('os dois formatos convivem no mesmo arquivo', async () => {
    const adapter = await setUp({
      config: `${LEGACY}
[profile novo]
sso_session = s
sso_account_id = 111122223333
sso_role_name = r
region = us-east-1

[sso-session s]
sso_start_url = https://exemplo.awsapps.com/start
sso_region = us-east-1
`,
    });

    const profiles = await adapter.listProfiles();

    expect(profiles.filter((profile) => profile.kind === 'sso').map((p) => p.name).sort()).toEqual([
      'legado',
      'novo',
    ]);
  });
});

describe('profiles sem SSO são bloqueados', () => {
  it('chave estática em ~/.aws/credentials é bloqueada', async () => {
    // O cenário exato do spec: existe um [default] com chave estática, e
    // apresentá-lo como equivalente a um profile SSO seria perigoso.
    const adapter = await setUp({
      config: '[default]\nregion = us-east-1\n',
      credentials: '[default]\naws_access_key_id = AKIAEXEMPLO\naws_secret_access_key = segredo\n',
    });

    const profile = await adapter.findProfile('default');

    expect(profile).toMatchObject({
      kind: 'staticKeys',
      selectable: false,
      sessionState: 'notApplicable',
    });
    expect(profile?.blockedReason).toMatch(/chave de acesso estática/);
  });

  it('chave estática declarada no config também é bloqueada', async () => {
    const adapter = await setUp({
      config: '[profile inline]\naws_access_key_id = AKIA\naws_secret_access_key = s\n',
    });

    expect((await adapter.findProfile('inline'))?.kind).toBe('staticKeys');
  });

  it('profile só com region é incompleto e bloqueado', async () => {
    const adapter = await setUp({ config: '[profile vazio]\nregion = us-east-1\n' });

    const profile = await adapter.findProfile('vazio');

    expect(profile?.kind).toBe('incomplete');
    expect(profile?.selectable).toBe(false);
    expect(profile?.blockedReason).toMatch(/nem configuração de SSO nem credencial/);
  });

  it('profile que existe só em credentials aparece na lista, bloqueado', async () => {
    // Aparecer importa: quem procura o profile e não o encontra conclui que a
    // ferramenta está quebrada, em vez de entender o motivo.
    const adapter = await setUp({
      config: '',
      credentials: '[so-credencial]\naws_access_key_id = AKIA\naws_secret_access_key = s\n',
    });

    const profile = await adapter.findProfile('so-credencial');

    expect(profile?.kind).toBe('staticKeys');
    expect(profile?.selectable).toBe(false);
  });

  it('nenhum profile bloqueado carrega a chave de acesso', async () => {
    const sentinel = 'AKIA-SENTINEL-9d3f-DO-NOT-LEAK';
    const adapter = await setUp({
      config: '[default]\nregion = us-east-1\n',
      credentials: `[default]\naws_access_key_id = ${sentinel}\naws_secret_access_key = ${sentinel}\n`,
    });

    const profiles = await adapter.listProfiles();

    expect(JSON.stringify(profiles)).not.toContain(sentinel);
  });
});

describe('ordenação e login', () => {
  it('profiles SSO vêm antes dos bloqueados', async () => {
    const adapter = await setUp({
      config: `
[profile zzz-sso]
sso_session = s
sso_account_id = 1
sso_role_name = r
region = us-east-1

[sso-session s]
sso_start_url = https://exemplo.awsapps.com/start
sso_region = us-east-1

[profile aaa-estatico]
aws_access_key_id = AKIA
aws_secret_access_key = s
`,
    });

    expect((await adapter.listProfiles()).map((profile) => profile.name)).toEqual([
      'zzz-sso',
      'aaa-estatico',
    ]);
  });

  it('login em profile inexistente é recusado', async () => {
    const adapter = await setUp({ config: '' });

    await expect(adapter.login('nao-existe')).rejects.toThrow(ProfileNotUsableError);
  });

  it('login em profile de chave estática é recusado, sem executar nada', async () => {
    // Aceitar o pedido daria a impressão de que o profile passou a valer.
    const adapter = await setUp({
      config: '[default]\nregion = us-east-1\n',
      credentials: '[default]\naws_access_key_id = AKIA\naws_secret_access_key = s\n',
    });

    await expect(adapter.login('default')).rejects.toThrow(/chave de acesso estática/);
  });
});
