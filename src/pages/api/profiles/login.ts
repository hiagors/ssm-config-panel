import type { APIRoute } from 'astro';
import { InvalidRequestBodyError, SsoLoginFailedError } from '../../../domain/errors.js';
import { getSsoAuth, resetParameterStores } from '../../../infrastructure/store/index.js';
import { errorResponse, jsonResponse } from '../_http.js';

export const prerender = false;

/**
 * `POST /api/profiles/login` — dispara `aws sso login` e abre o navegador.
 *
 * É rota mutante: passa pela verificação de Origin e Host no middleware, como
 * qualquer outra. Isso não é formalidade — sem a checagem, uma aba maliciosa
 * poderia disparar login e, pior, escolher o profile.
 *
 * Não devolve token nem credencial. Só se o comando terminou bem; o estado da
 * sessão vem depois de `GET /api/profiles`, que a UI consulta em polling.
 */
export const POST: APIRoute = async ({ request }) => {
  try {
    const profileName = await readProfileName(request);
    const result = await getSsoAuth().login(profileName);

    if (!result.ok) {
      throw new SsoLoginFailedError(
        profileName,
        result.message ?? 'O login não foi concluído.',
      );
    }

    // O client memoizado carrega um provider que já falhou; reusá-lo manteria a
    // sessão como expirada mesmo depois de reautenticar.
    resetParameterStores();

    return jsonResponse({ ok: true, profileName });
  } catch (error) {
    return errorResponse(error);
  }
};

async function readProfileName(request: Request): Promise<string> {
  let raw: unknown;

  try {
    raw = await request.json();
  } catch {
    throw new InvalidRequestBodyError('o corpo da requisição não é JSON válido');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidRequestBodyError('o corpo da requisição precisa ser um objeto');
  }

  const profileName = (raw as Record<string, unknown>)['profileName'];

  if (typeof profileName !== 'string' || profileName.trim() === '') {
    throw new InvalidRequestBodyError('o campo "profileName" precisa ser um texto não vazio');
  }

  return profileName.trim();
}
