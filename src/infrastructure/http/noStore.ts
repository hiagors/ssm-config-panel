/**
 * Fonte única dos cabeçalhos de não-cache.
 *
 * Está fora de `middleware.ts` de propósito: aquele arquivo importa
 * `astro:middleware`, um módulo virtual que só existe dentro do build do
 * Astro, e por isso não é carregável em teste unitário. Deixar a lógica aqui
 * permite testá-la direto, e o middleware fica sendo só a fiação.
 *
 * Ter um único módulo também elimina a chance de o helper de `/api/*` e o
 * middleware divergirem — antes eram duas listas de cabeçalhos que precisavam
 * ser mantidas iguais na mão.
 */

/** Sem cache em disco, sem cache de proxy, sem reinterpretação de conteúdo. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

/**
 * Aplica os cabeçalhos na resposta.
 *
 * Se os cabeçalhos da resposta forem imutáveis, reconstrói preservando corpo,
 * status e cabeçalhos originais. O corpo é repassado como está, então o
 * streaming de HTML do Astro continua funcionando.
 */
export function applyNoStore(response: Response): Response {
  try {
    for (const [header, value] of Object.entries(NO_STORE_HEADERS)) {
      response.headers.set(header, value);
    }
    return response;
  } catch {
    const headers = new Headers(response.headers);

    for (const [header, value] of Object.entries(NO_STORE_HEADERS)) {
      headers.set(header, value);
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
}
