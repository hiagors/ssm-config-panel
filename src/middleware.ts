import { defineMiddleware } from 'astro:middleware';
import { applyNoStore } from './infrastructure/http/noStore.js';

/**
 * Ponto único onde `Cache-Control: no-store` é aplicado.
 *
 * O helper de resposta em `pages/api/_http.ts` cobre as rotas de API, mas não
 * alcança as páginas `.astro` — e a página do editor carrega o valor do
 * parâmetro duas vezes no HTML: no SSR e nos props da ilha React. Sem isto,
 * essa página era servida sem nenhum cabeçalho de cache.
 *
 * Estar no middleware é o que torna a regra estrutural: uma rota nova nasce
 * coberta, sem depender de alguém lembrar.
 *
 * A lógica em si mora em `infrastructure/http/noStore.ts`, para poder ser
 * testada sem carregar o módulo virtual `astro:middleware`.
 *
 * Fase 2b: é aqui que entra a verificação de CSRF de toda rota não-GET, junto
 * com a validação de Host contra DNS rebinding.
 */
export const onRequest = defineMiddleware(async (_context, next) => {
  return applyNoStore(await next());
});
