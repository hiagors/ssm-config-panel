import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ParameterNotFoundError, StoreUnavailableError } from '../../domain/errors.js';
import { inspectJson } from '../../application/GetParameterUseCase.js';
import {
  NO_STORE_HEADERS,
  errorResponse,
  jsonResponse,
  mapError,
  redactedLogLine,
} from './_http.js';

/**
 * Teste de valor sentinela.
 *
 * O sentinela finge ser um `SecureString` decriptado. A asserção é sempre a
 * mesma e vale para toda saída da fronteira HTTP: o texto do sentinela não
 * pode aparecer em nenhum lugar — corpo da resposta, cabeçalho ou log.
 *
 * Testar assim, e não "a mensagem é a esperada", é o que pega o vazamento
 * indireto: mensagem de biblioteca, `cause` aninhada, stack trace.
 */
const SENTINEL = 'SENTINEL-c2VjcmV0-DO-NOT-LEAK-9f3a1b';

/** Todo lugar por onde um segredo poderia escapar de uma Response. */
async function allExposedText(response: Response): Promise<string> {
  const headers = [...response.headers.entries()]
    .map(([key, value]) => `${key}: ${value}`)
    .join('\n');
  return `${response.status}\n${headers}\n${await response.text()}`;
}

describe('_http — redação por padrão', () => {
  let consoleError: ReturnType<typeof vi.spyOn>;
  let logged: string[];

  beforeEach(() => {
    logged = [];
    consoleError = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(' '));
    });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('não vaza a mensagem de um erro desconhecido', async () => {
    const error = new Error(`falha ao processar o valor ${SENTINEL}`);

    const exposed = await allExposedText(errorResponse(error));

    expect(exposed).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('não vaza o sentinela escondido em cause aninhada', async () => {
    const root = new Error(`credencial=${SENTINEL}`);
    const middle = new Error('falha na camada intermediária', { cause: root });
    const outer = new Error('falha na borda', { cause: middle });

    const exposed = await allExposedText(errorResponse(outer));

    expect(exposed).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('não vaza o sentinela presente no stack trace', async () => {
    const error = new Error('falha genérica');
    error.stack = `Error: falha\n    at parseValue ("${SENTINEL}":1:1)`;

    const exposed = await allExposedText(errorResponse(error));

    expect(exposed).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('não vaza o trecho que o JSON.parse embute na mensagem', async () => {
    // Este é o vazamento mais fácil de cometer: a mensagem nativa do
    // JSON.parse inclui parte do texto de entrada.
    let parseError: unknown;
    try {
      JSON.parse(`{"token": "${SENTINEL}"`);
    } catch (error) {
      parseError = error;
    }

    expect(parseError).toBeInstanceOf(SyntaxError);

    const exposed = await allExposedText(errorResponse(parseError));

    expect(exposed).not.toContain(SENTINEL);
    expect(logged.join('\n')).not.toContain(SENTINEL);
  });

  it('inspectJson descreve a falha sem repassar o conteúdo', () => {
    const result = inspectJson(`{"token": "${SENTINEL}"`);

    expect(result.isValidJson).toBe(false);
    expect(result.jsonError).toBeDefined();
    expect(result.jsonError).not.toContain(SENTINEL);
  });

  it('redactedLogLine não repassa mensagem de erro desconhecido', () => {
    const line = redactedLogLine(new Error(SENTINEL));

    expect(line).not.toContain(SENTINEL);
    expect(line).toContain('detalhe suprimido');
  });

  it('mapeia erro desconhecido para 500 com código genérico', () => {
    const { status, body } = mapError(new Error(SENTINEL));

    expect(status).toBe(500);
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).not.toContain(SENTINEL);
  });

  it('repassa a publicMessage curada de um AppError', async () => {
    const error = new ParameterNotFoundError('/example/demo/env');

    const response = errorResponse(error);
    const exposed = await allExposedText(response);

    expect(response.status).toBe(404);
    expect(exposed).toContain('PARAMETER_NOT_FOUND');
    // O name do parâmetro não é segredo e ajuda a agir sobre o erro.
    expect(exposed).toContain('/example/demo/env');
  });

  it('não repassa a mensagem interna de um AppError, só a pública', async () => {
    // A mensagem interna existe para o desenvolvedor, e pode ter sido
    // construída com detalhe que não queremos expor.
    const error = new StoreUnavailableError(
      `conexão falhou com token ${SENTINEL}`,
      'O store local não está acessível. Verifique ./.local-store.',
    );

    const exposed = await allExposedText(errorResponse(error));

    expect(exposed).not.toContain(SENTINEL);
    expect(exposed).toContain('./.local-store');
  });
});

describe('_http — Cache-Control', () => {
  it('resposta de sucesso sai com no-store', () => {
    const response = jsonResponse({ ok: true });

    expect(response.headers.get('Cache-Control')).toBe(NO_STORE_HEADERS['Cache-Control']);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('resposta de erro também sai com no-store', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const response = errorResponse(new ParameterNotFoundError('/example/demo/env'));

    expect(response.headers.get('Cache-Control')).toContain('no-store');
    vi.restoreAllMocks();
  });

  it('declara os cabeçalhos de endurecimento junto', () => {
    const response = jsonResponse({ ok: true });

    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(response.headers.get('Pragma')).toBe('no-cache');
  });
});
