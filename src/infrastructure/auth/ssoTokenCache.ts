import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { SsoSessionState } from '../../domain/AwsProfile.js';

/**
 * Leitura do cache de token do AWS SSO.
 *
 * O cache fica em `~/.aws/sso/cache/`, e o nome de cada arquivo é o **SHA-1 da
 * chave da sessão**:
 *
 * - formato novo (`[sso-session NOME]`): `sha1(NOME)`
 * - formato legado (`sso_start_url` inline no profile): `sha1(sso_start_url)`
 *
 * Verificado contra a máquina real: `sha1('hiago-sso-appmax')` casa exatamente
 * com um dos arquivos.
 *
 * Ler o cache — em vez de tentar obter credenciais e ver se falha — é o que
 * permite distinguir os três estados que o spec pede. Uma tentativa de
 * credencial só diria "funcionou ou não", colapsando *expirada* e *nunca
 * autenticada* no mesmo resultado. E é offline: sem chamada de rede para
 * pintar a tela inicial.
 *
 * Este módulo **nunca** devolve o `accessToken`. Só o estado e a validade.
 */

/** Nomes de campo que jamais saem daqui. */
const SECRET_FIELDS = ['accessToken', 'clientSecret', 'refreshToken'] as const;

export interface CachedSessionInfo {
  readonly state: SsoSessionState;
  /** ISO 8601 da expiração, quando há token em cache. */
  readonly expiresAt: string | undefined;
}

const NEVER_AUTHENTICATED: CachedSessionInfo = Object.freeze({
  state: 'neverAuthenticated',
  expiresAt: undefined,
});

export function ssoCacheDirectory(
  environment: Record<string, string | undefined> = process.env,
): string {
  // Override existe para teste; o AWS CLI não tem env var para isto.
  const override = environment['AWS_SSO_CACHE_DIR']?.trim();

  return override !== undefined && override !== ''
    ? override
    : join(homedir(), '.aws', 'sso', 'cache');
}

/** `sha1` hexadecimal, o esquema que o AWS CLI usa para nomear o cache. */
export function cacheFileNameFor(sessionKey: string): string {
  return `${createHash('sha1').update(sessionKey, 'utf8').digest('hex')}.json`;
}

/**
 * Estado da sessão de uma sso-session (formato novo) ou start URL (legado).
 *
 * @param sessionKey nome do bloco `[sso-session]`, ou a `sso_start_url` no
 *        formato legado.
 * @param startUrl usado como desempate quando o arquivo exato não existe.
 */
export async function readSessionState(
  sessionKey: string | undefined,
  startUrl: string | undefined,
  now: Date,
  cacheDirectory: string = ssoCacheDirectory(),
): Promise<CachedSessionInfo> {
  if (sessionKey === undefined && startUrl === undefined) {
    return NEVER_AUTHENTICATED;
  }

  if (sessionKey !== undefined) {
    const exact = await readTokenFile(join(cacheDirectory, cacheFileNameFor(sessionKey)));

    if (exact !== undefined) {
      return classify(exact.expiresAt, now);
    }
  }

  // O arquivo exato não existe. Pode ser versão do CLI com outro esquema de
  // nome, ou formato legado. Varremos o diretório procurando token com a mesma
  // start URL, e escolhemos o de expiração mais distante: token válido em
  // qualquer arquivo significa sessão válida, e reportar "expirada" porque
  // olhamos o arquivo antigo mandaria o usuário reautenticar sem motivo.
  if (startUrl === undefined) {
    return NEVER_AUTHENTICATED;
  }

  const candidates = await readAllTokensForStartUrl(cacheDirectory, startUrl);

  if (candidates.length === 0) {
    return NEVER_AUTHENTICATED;
  }

  const latest = candidates.reduce((best, current) =>
    current.expiresAtMillis > best.expiresAtMillis ? current : best,
  );

  return classify(latest.expiresAt, now);
}

function classify(expiresAt: string | undefined, now: Date): CachedSessionInfo {
  if (expiresAt === undefined) {
    return NEVER_AUTHENTICATED;
  }

  const expiryMillis = Date.parse(expiresAt);

  if (Number.isNaN(expiryMillis)) {
    // Cache corrompido conta como expirado: força reautenticação, que é o
    // caminho seguro.
    return { state: 'expired', expiresAt: undefined };
  }

  return expiryMillis > now.getTime()
    ? { state: 'valid', expiresAt }
    : { state: 'expired', expiresAt };
}

interface TokenFile {
  readonly startUrl: string | undefined;
  readonly expiresAt: string | undefined;
  readonly expiresAtMillis: number;
}

/**
 * Lê um arquivo de token.
 *
 * Devolve `undefined` para arquivo ausente, ilegível, não-JSON, ou que seja um
 * registro de cliente OIDC em vez de token — esses têm `clientId` e
 * `clientSecret` mas nem `startUrl` nem `accessToken`, e confundi-los com
 * token faria a tela reportar sessão onde não há.
 */
async function readTokenFile(path: string): Promise<TokenFile | undefined> {
  let raw: string;

  try {
    raw = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Nunca repassar a mensagem do JSON.parse: ela embute trecho do arquivo, e
    // o arquivo contém accessToken.
    return undefined;
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const record = parsed as Record<string, unknown>;

  // Registro de cliente, não token de acesso.
  if (typeof record['accessToken'] !== 'string') {
    return undefined;
  }

  const expiresAt = typeof record['expiresAt'] === 'string' ? record['expiresAt'] : undefined;

  return {
    startUrl: typeof record['startUrl'] === 'string' ? record['startUrl'] : undefined,
    expiresAt,
    expiresAtMillis: expiresAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(expiresAt),
  };
}

async function readAllTokensForStartUrl(
  cacheDirectory: string,
  startUrl: string,
): Promise<TokenFile[]> {
  let entries: string[];

  try {
    entries = await readdir(cacheDirectory);
  } catch {
    return [];
  }

  const matches: TokenFile[] = [];

  for (const entry of entries) {
    if (!entry.endsWith('.json')) {
      continue;
    }

    const token = await readTokenFile(join(cacheDirectory, entry));

    if (token !== undefined && sameStartUrl(token.startUrl, startUrl)) {
      matches.push(token);
    }
  }

  return matches;
}

/** Compara start URLs ignorando barra final, que varia entre configurações. */
function sameStartUrl(left: string | undefined, right: string): boolean {
  if (left === undefined) {
    return false;
  }
  return left.replace(/\/+$/, '') === right.replace(/\/+$/, '');
}

/** Exportado só para o teste assertar que nenhum campo secreto é lido. */
export const SECRET_TOKEN_FIELDS: readonly string[] = SECRET_FIELDS;
