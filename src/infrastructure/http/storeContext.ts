import type { StoreContext } from '../store/index.js';
import { resolveDriver } from '../store/index.js';

/**
 * Extrai o contexto de store de uma URL.
 *
 * O profile vem **sempre da requisição**, no parâmetro `profile`, e nunca de
 * um estado de servidor. Não há fallback para `AWS_PROFILE`: a variável de
 * ambiente serve para pré-selecionar no seletor da tela inicial, e mais nada.
 *
 * A diferença importa. Se a resolução caísse em `AWS_PROFILE` quando o
 * parâmetro faltasse, uma requisição sem profile — de um link antigo, de um
 * bookmark, de um bug de front — operaria em silêncio sob outra identidade.
 * Faltando o profile, o driver `aws` falha e diz o que faltou.
 */
export const PROFILE_QUERY_PARAM = 'profile';

export function storeContextFromUrl(url: URL): StoreContext {
  const driver = resolveDriver();

  if (driver === 'local') {
    return { driver, profileName: undefined };
  }

  const raw = url.searchParams.get(PROFILE_QUERY_PARAM)?.trim();

  return { driver, profileName: raw === '' ? undefined : raw ?? undefined };
}

/** Anexa o profile atual a um caminho interno, preservando a identidade. */
export function withProfile(path: string, profileName: string | undefined): string {
  if (profileName === undefined || profileName === '') {
    return path;
  }

  const separator = path.includes('?') ? '&' : '?';

  return `${path}${separator}${PROFILE_QUERY_PARAM}=${encodeURIComponent(profileName)}`;
}
