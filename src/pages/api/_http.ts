import { isAppError } from '../../domain/errors.js';
import type { AppErrorCode } from '../../domain/errors.js';

/**
 * Fronteira HTTP: cabeçalhos e mapeamento de erro.
 *
 * Duas garantias, testadas em `_http.test.ts` com valor sentinela:
 *
 * 1. **Nunca cacheia.** Toda resposta sai com `Cache-Control: no-store`.
 *    Respostas carregam valor de parâmetro, incluindo `SecureString`
 *    decriptado; cache de disco do browser ou proxy intermediário
 *    persistiria segredo fora do nosso controle.
 *
 * 2. **Redige por padrão.** O mapeamento de erro é allow-list: só a
 *    `publicMessage` curada de um `AppError` atravessa. Qualquer outro erro
 *    vira mensagem genérica. `message`, `cause` e `stack` de erro
 *    desconhecido nunca saem daqui, nem para o browser nem para o log.
 *
 * O arquivo tem prefixo `_` para o Astro não tratá-lo como rota.
 */

/** Sem cache em disco, sem cache de proxy, sem armazenar no histórico. */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  Pragma: 'no-cache',
  Expires: '0',
  // A resposta não deve ser reinterpretada nem embutida por outra origem.
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
});

export interface ErrorBody {
  readonly error: {
    readonly code: AppErrorCode;
    readonly message: string;
  };
}

/** Resposta JSON de sucesso, sempre `no-store`. */
export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...NO_STORE_HEADERS,
    },
  });
}

/**
 * Traduz qualquer erro em resposta segura.
 *
 * A allow-list é a inversão de controle que importa: em vez de tentar
 * remover segredo de uma mensagem arbitrária, só deixamos passar texto que
 * nós mesmos escrevemos.
 */
export function errorResponse(error: unknown): Response {
  const { status, body } = mapError(error);
  logRedacted(error);
  return jsonResponse(body, status);
}

export function mapError(error: unknown): { status: number; body: ErrorBody } {
  if (isAppError(error)) {
    return {
      status: error.httpStatus,
      body: { error: { code: error.code, message: error.publicMessage } },
    };
  }

  return {
    status: 500,
    body: {
      error: {
        code: 'INTERNAL_ERROR',
        message:
          'Erro interno inesperado. O detalhe técnico não é exibido porque pode conter ' +
          'valor de parâmetro. Consulte o terminal onde o servidor está rodando.',
      },
    },
  };
}

/**
 * Log de servidor redigido.
 *
 * Loga o nome da classe e, quando é `AppError`, o código e a mensagem
 * pública. Para erro desconhecido loga só o construtor: `error.message` de
 * biblioteca pode conter valor de parâmetro — `JSON.parse` é o caso
 * clássico, porque embute um trecho da entrada na mensagem.
 *
 * Consequência aceita: erro inesperado fica difícil de depurar pelo log.
 * O spec é explícito em priorizar não vazar segredo. Para depurar, ponha um
 * breakpoint — não afrouxe esta função.
 */
export function logRedacted(error: unknown): void {
  console.error(`[ssm-config-panel] ${redactedLogLine(error)}`);
}

export function redactedLogLine(error: unknown): string {
  if (isAppError(error)) {
    return `${error.name} code=${error.code} status=${error.httpStatus}: ${error.publicMessage}`;
  }

  const constructorName =
    typeof error === 'object' && error !== null ? error.constructor.name : typeof error;

  return `erro não tratado (${constructorName}); detalhe suprimido por política de redação`;
}

/** Extrai o name do parâmetro da rota `/api/parameters/[...name]`. */
export function parameterNameFromRoute(routeParam: string | undefined): string {
  if (routeParam === undefined || routeParam === '') {
    return '';
  }
  // O Astro entrega o rest param já decodificado, sem barra inicial.
  return routeParam.startsWith('/') ? routeParam : `/${routeParam}`;
}
