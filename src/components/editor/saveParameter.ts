import type { SaveOutcome } from '../../application/SaveParameterUseCase.js';

/**
 * Cliente da rota de gravação.
 *
 * Separado do componente para o fluxo de save ser testável sem React.
 *
 * O corpo carrega `expectedVersion` sempre. Não existe caminho neste arquivo
 * que grave sem ele — é o que impede que uma chamada nova esqueça a proteção
 * contra escrita concorrente.
 */

export type SaveRequestResult =
  | { readonly ok: true; readonly outcome: SaveOutcome }
  | { readonly ok: false; readonly message: string };

export async function saveParameter(
  name: string,
  value: string,
  expectedVersion: number,
  profileName?: string | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<SaveRequestResult> {
  let response: Response;

  // O profile viaja na URL, igual às leituras. Nunca é inferido no servidor:
  // uma gravação sob identidade adivinhada é o pior erro possível aqui.
  const query =
    profileName === undefined || profileName === ''
      ? ''
      : `?profile=${encodeURIComponent(profileName)}`;

  try {
    response = await fetchImpl(`/api/parameters${name}${query}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      // Mesma origem: o middleware recusa qualquer outra, e sem isto o browser
      // não enviaria os cabeçalhos que ele usa para decidir.
      credentials: 'same-origin',
      body: JSON.stringify({ value, expectedVersion }),
    });
  } catch {
    // Nunca inclua `value` na mensagem: pode ser SecureString decriptado.
    return {
      ok: false,
      message: 'Não foi possível falar com o servidor. Ele ainda está rodando?',
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      message: `O servidor respondeu ${response.status} com um corpo que não é JSON.`,
    };
  }

  if (isSaveOutcome(body)) {
    return { ok: true, outcome: body };
  }

  // Resposta de erro do mapper central: `{ error: { code, message } }`, já
  // redigida no servidor.
  const message = errorMessageOf(body);

  return {
    ok: false,
    message: message ?? `O servidor respondeu ${response.status} sem detalhe utilizável.`,
  };
}

function isSaveOutcome(body: unknown): body is SaveOutcome {
  if (typeof body !== 'object' || body === null) {
    return false;
  }

  const outcome = (body as { outcome?: unknown }).outcome;

  return (
    outcome === 'saved' || outcome === 'conflict' || outcome === 'notFound' || outcome === 'invalid'
  );
}

function errorMessageOf(body: unknown): string | undefined {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }

  const error = (body as { error?: unknown }).error;

  if (typeof error !== 'object' || error === null) {
    return undefined;
  }

  const message = (error as { message?: unknown }).message;

  return typeof message === 'string' ? message : undefined;
}
