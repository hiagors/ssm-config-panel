import { defineMiddleware } from 'astro:middleware';
import { applyNoStore } from './infrastructure/http/noStore.js';
import { assertRequestIsTrusted, originPolicyFromEnvironment } from './infrastructure/http/csrf.js';
import { errorResponse } from './pages/api/_http.js';

/**
 * Ponto único das duas regras que não podem depender de disciplina por rota.
 *
 * **1. `Cache-Control: no-store` em toda resposta.** O helper de
 * `pages/api/_http.ts` cobre as rotas de API, mas não alcança as páginas
 * `.astro` — e a página do editor carrega o valor do parâmetro duas vezes no
 * HTML: no SSR e nos props da ilha React.
 *
 * **2. Origem e Host confiáveis.** Loopback não é fronteira de segurança
 * contra o browser: qualquer aba pode fazer requisição para `127.0.0.1`, e um
 * domínio do atacante pode resolver para `127.0.0.1` para fazer o `Host`
 * parecer legítimo. Ver `infrastructure/http/csrf.ts`.
 *
 * Estar aqui é o que torna as regras estruturais: rota nova nasce coberta.
 */

const originPolicy = originPolicyFromEnvironment();

export const onRequest = defineMiddleware(async (context, next) => {
  try {
    assertRequestIsTrusted(context.request, originPolicy);
  } catch (error) {
    // Recusa antes de qualquer rota rodar, então nenhum valor de parâmetro é
    // sequer lido do store. A resposta passa pelo mapper, que redige.
    return applyNoStore(errorResponse(error));
  }

  return applyNoStore(await next());
});
