import { spawn } from 'node:child_process';
import { fromSSO } from '@aws-sdk/credential-providers';
import { loadSharedConfigFiles } from '@smithy/shared-ini-file-loader';
import type { AwsProfile, ProfileKind } from '../../domain/AwsProfile.js';
import { ProfileNotUsableError, SsoLoginFailedError } from '../../domain/errors.js';
import type { LoginResult, SsoAuthPort } from './SsoAuthPort.js';
import { readSessionState, ssoCacheDirectory } from './ssoTokenCache.js';

/**
 * Autenticação via AWS SSO, usando o navegador local.
 *
 * Três decisões que valem registro:
 *
 * 1. **`loadSharedConfigFiles()` em vez de parsear INI.** Ele resolve o
 *    formato novo (`[sso-session NOME]` referenciado por `sso_session`) e o
 *    legado (`sso_start_url` inline), respeita `AWS_CONFIG_FILE`, e devolve os
 *    blocos de sessão como chaves `sso-session.NOME`.
 *
 * 2. **`fromSSO()` explícito, nunca a cadeia default.** A cadeia default
 *    tentaria variável de ambiente e `~/.aws/credentials` antes do SSO — e
 *    existe um `[default]` com chave estática nesta máquina. Uma operação em
 *    produção sob identidade esquecida é exatamente o que não pode acontecer.
 *
 * 3. **Profile com chave estática é bloqueado, não só marcado.** O spec aceita
 *    "bloqueie ou marque"; bloquear é o lado seguro. A UI explica o motivo em
 *    vez de apenas desabilitar.
 */
export class AwsSsoAdapter implements SsoAuthPort {
  /** Logins em andamento, para dois cliques não abrirem dois navegadores. */
  private readonly loginsInFlight = new Map<string, Promise<LoginResult>>();

  constructor(
    private readonly cacheDirectory: string = ssoCacheDirectory(),
    private readonly loginTimeoutMillis: number = 180_000,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async listProfiles(): Promise<AwsProfile[]> {
    const { configFile, credentialsFile } = await loadSharedConfigFiles({ ignoreCache: true });

    const ssoSessions = extractSsoSessions(configFile);
    const names = collectProfileNames(configFile, credentialsFile);
    const profiles: AwsProfile[] = [];

    for (const name of names) {
      profiles.push(
        await this.buildProfile(
          name,
          configFile[name] ?? {},
          credentialsFile[name] ?? {},
          ssoSessions,
        ),
      );
    }

    // SSO primeiro, depois o resto — o que é utilizável fica no topo.
    return profiles.sort((left, right) => {
      if (left.kind !== right.kind) {
        return left.kind === 'sso' ? -1 : right.kind === 'sso' ? 1 : 0;
      }
      return left.name.localeCompare(right.name);
    });
  }

  async findProfile(profileName: string): Promise<AwsProfile | undefined> {
    const profiles = await this.listProfiles();
    return profiles.find((profile) => profile.name === profileName);
  }

  async login(profileName: string): Promise<LoginResult> {
    const profile = await this.findProfile(profileName);

    if (profile === undefined) {
      throw new ProfileNotUsableError(profileName, 'não existe em ~/.aws/config');
    }

    if (profile.kind !== 'sso') {
      // Nunca disparar login para profile de chave estática: não há o que
      // autenticar, e aceitar o pedido daria a impressão de que passou a valer.
      throw new ProfileNotUsableError(
        profileName,
        profile.blockedReason ?? 'não é um profile SSO',
      );
    }

    const running = this.loginsInFlight.get(profileName);

    if (running !== undefined) {
      return running;
    }

    const attempt = this.runLoginCommand(profileName).finally(() => {
      this.loginsInFlight.delete(profileName);
    });

    this.loginsInFlight.set(profileName, attempt);

    return attempt;
  }

  credentialsFor(profileName: string): unknown {
    // `fromSSO` lê o cache em ~/.aws/sso/cache e troca o token por credenciais
    // temporárias. Nada disso atravessa a fronteira HTTP.
    return fromSSO({ profile: profileName });
  }

  /**
   * Executa `aws sso login --profile <name>`.
   *
   * A saída do comando é repassada para o terminal do servidor de propósito: o
   * `aws sso login` imprime a URL e o código de verificação, e o usuário pode
   * precisar deles se o navegador não abrir. Não é valor de parâmetro, e é o
   * mesmo terminal onde a pessoa já está.
   */
  private runLoginCommand(profileName: string): Promise<LoginResult> {
    return new Promise((resolve) => {
      const child = spawn('aws', ['sso', 'login', '--profile', profileName], {
        // `inherit` no stdout/stderr: a URL e o código aparecem para o usuário.
        stdio: ['ignore', 'inherit', 'inherit'],
      });

      const timeout = setTimeout(() => {
        child.kill('SIGTERM');
        resolve({
          ok: false,
          message:
            `O login expirou depois de ${Math.round(this.loginTimeoutMillis / 1000)}s sem ` +
            `conclusão. Confira o navegador e tente de novo.`,
        });
      }, this.loginTimeoutMillis);

      child.on('error', (error) => {
        clearTimeout(timeout);
        // A mensagem do Node aqui é sobre o binário, não sobre credenciais.
        const isMissing = (error as NodeJS.ErrnoException).code === 'ENOENT';
        resolve({
          ok: false,
          message: isMissing
            ? 'O comando "aws" não foi encontrado no PATH do servidor. Rode make check-deps.'
            : 'Não foi possível iniciar o comando "aws sso login".',
        });
      });

      child.on('close', (code) => {
        clearTimeout(timeout);

        if (code === 0) {
          resolve({ ok: true, message: undefined });
          return;
        }

        resolve({
          ok: false,
          message:
            `O comando "aws sso login --profile ${profileName}" terminou com código ${code}. ` +
            `O detalhe está no terminal onde o servidor está rodando.`,
        });
      });
    });
  }

  private async buildProfile(
    name: string,
    config: Record<string, unknown>,
    credentials: Record<string, unknown>,
    ssoSessions: ReadonlyMap<string, SsoSessionConfig>,
  ): Promise<AwsProfile> {
    const ssoSessionName = stringOf(config['sso_session']);
    const session = ssoSessionName === undefined ? undefined : ssoSessions.get(ssoSessionName);

    // Formato novo tira a start URL do bloco [sso-session]; legado tem inline.
    const ssoStartUrl = session?.startUrl ?? stringOf(config['sso_start_url']);
    const kind = classifyProfile(config, credentials, ssoStartUrl);
    const region = stringOf(config['region']) ?? session?.region;

    const { state, expiresAt } =
      kind === 'sso'
        ? await readSessionState(
            // Formato novo indexa o cache pelo nome da sessão; legado, pela URL.
            ssoSessionName ?? ssoStartUrl,
            ssoStartUrl,
            this.now(),
            this.cacheDirectory,
          )
        : { state: 'notApplicable' as const, expiresAt: undefined };

    return {
      name,
      kind,
      accountId: stringOf(config['sso_account_id']),
      roleName: stringOf(config['sso_role_name']),
      region,
      ssoStartUrl,
      ssoSessionName,
      sessionState: state,
      expiresAt,
      selectable: kind === 'sso',
      blockedReason: blockedReasonFor(kind),
    };
  }
}

interface SsoSessionConfig {
  readonly startUrl: string | undefined;
  readonly region: string | undefined;
}

/** Prefixo com que `loadSharedConfigFiles` expõe blocos `[sso-session X]`. */
const SSO_SESSION_PREFIX = 'sso-session.';

function extractSsoSessions(
  configFile: Record<string, Record<string, unknown>>,
): ReadonlyMap<string, SsoSessionConfig> {
  const sessions = new Map<string, SsoSessionConfig>();

  for (const [key, value] of Object.entries(configFile)) {
    if (!key.startsWith(SSO_SESSION_PREFIX)) {
      continue;
    }

    sessions.set(key.slice(SSO_SESSION_PREFIX.length), {
      startUrl: stringOf(value['sso_start_url']),
      region: stringOf(value['sso_region']),
    });
  }

  return sessions;
}

function collectProfileNames(
  configFile: Record<string, unknown>,
  credentialsFile: Record<string, unknown>,
): string[] {
  const names = new Set<string>();

  for (const key of Object.keys(configFile)) {
    // Blocos de sessão não são profiles selecionáveis.
    if (!key.startsWith(SSO_SESSION_PREFIX)) {
      names.add(key);
    }
  }

  // Um profile pode existir apenas em ~/.aws/credentials. Precisa aparecer na
  // lista justamente para ser mostrado como bloqueado.
  for (const key of Object.keys(credentialsFile)) {
    names.add(key);
  }

  return [...names];
}

function classifyProfile(
  config: Record<string, unknown>,
  credentials: Record<string, unknown>,
  ssoStartUrl: string | undefined,
): ProfileKind {
  if (ssoStartUrl !== undefined) {
    return 'sso';
  }

  // Chave estática pode estar nos dois arquivos.
  const hasStaticKeys =
    stringOf(config['aws_access_key_id']) !== undefined ||
    stringOf(credentials['aws_access_key_id']) !== undefined;

  return hasStaticKeys ? 'staticKeys' : 'incomplete';
}

function blockedReasonFor(kind: ProfileKind): string | undefined {
  switch (kind) {
    case 'sso':
      return undefined;
    case 'staticKeys':
      return (
        'Este profile usa chave de acesso estática, não SSO. Operar com ele significaria editar ' +
        'parâmetros sob uma identidade de longa duração que a tela não consegue identificar — ' +
        'por isso está bloqueado.'
      );
    case 'incomplete':
      return (
        'Este profile não tem nem configuração de SSO nem credencial: só region ou output. ' +
        'Não há identidade com que operar.'
      );
  }
}

function stringOf(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** Exportado para o teste montar fixtures sem tocar em `~/.aws`. */
export const internals = {
  extractSsoSessions,
  collectProfileNames,
  classifyProfile,
  SSO_SESSION_PREFIX,
};

/** Reexport para o adapter do SSM tipar o retorno de `credentialsFor`. */
export type SsoCredentialProvider = ReturnType<typeof fromSSO>;

export function isSsoLoginFailure(result: LoginResult): boolean {
  return !result.ok;
}

export { SsoLoginFailedError };
