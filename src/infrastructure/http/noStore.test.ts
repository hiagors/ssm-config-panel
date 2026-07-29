import { describe, expect, it } from 'vitest';
import { NO_STORE_HEADERS, applyNoStore } from './noStore.js';

/**
 * O `no-store` é garantia estrutural, aplicada no middleware.
 *
 * O helper de `/api/*` cobria só as rotas de API, e não as páginas — mas a
 * página do editor serve o valor do parâmetro embutido no HTML, no SSR e nos
 * props da ilha React. Sem o middleware, essa página saía sem cabeçalho de
 * cache nenhum e o browser podia persistir o segredo em disco.
 */

describe('applyNoStore', () => {
  it('põe no-store em resposta HTML de página', () => {
    const response = applyNoStore(
      new Response('<html>valor do parâmetro aqui</html>', {
        headers: { 'Content-Type': 'text/html' },
      }),
    );

    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(response.headers.get('Pragma')).toBe('no-cache');
    expect(response.headers.get('Expires')).toBe('0');
  });

  it('põe os cabeçalhos de endurecimento', () => {
    const response = applyNoStore(new Response('ok'));

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('cobre resposta de erro também', () => {
    const response = applyNoStore(new Response('erro', { status: 500 }));

    expect(response.status).toBe(500);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('preserva status e corpo', async () => {
    const response = applyNoStore(new Response('corpo original', { status: 404 }));

    expect(response.status).toBe(404);
    expect(await response.text()).toBe('corpo original');
  });

  it('preserva cabeçalhos que já existiam', () => {
    const response = applyNoStore(
      new Response('ok', { headers: { 'Content-Type': 'text/html', 'X-Custom': 'mantido' } }),
    );

    expect(response.headers.get('Content-Type')).toBe('text/html');
    expect(response.headers.get('X-Custom')).toBe('mantido');
  });

  it('sobrescreve um Cache-Control permissivo que tenha vindo antes', () => {
    const response = applyNoStore(
      new Response('ok', { headers: { 'Cache-Control': 'public, max-age=31536000' } }),
    );

    expect(response.headers.get('Cache-Control')).not.toContain('public');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('funciona com corpo em stream, como o HTML do Astro', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('pedaço 1'));
        controller.close();
      },
    });

    const response = applyNoStore(new Response(stream));

    expect(response.headers.get('Cache-Control')).toContain('no-store');
    expect(await response.text()).toBe('pedaço 1');
  });

  it('a tabela de cabeçalhos é congelada', () => {
    // Fonte única compartilhada com o helper de API; mutação em runtime
    // afrouxaria a proteção nos dois lugares de uma vez.
    expect(Object.isFrozen(NO_STORE_HEADERS)).toBe(true);
  });
});
