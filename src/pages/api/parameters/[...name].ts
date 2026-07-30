import type { APIRoute } from 'astro';
import { GetParameterUseCase } from '../../../application/GetParameterUseCase.js';
import {
  SaveParameterUseCase,
  httpStatusForOutcome,
} from '../../../application/SaveParameterUseCase.js';
import {
  InvalidParameterNameError,
  InvalidRequestBodyError,
} from '../../../domain/errors.js';
import { storeContextFromUrl } from '../../../infrastructure/http/storeContext.js';
import { getBackupPort, resolveParameterStore } from '../../../infrastructure/store/index.js';
import { errorResponse, jsonResponse, parameterNameFromRoute } from '../_http.js';

export const prerender = false;

/**
 * `GET /api/parameters/example/demo/env` -> parâmetro `/example/demo/env`.
 *
 * A resposta pode conter valor de `SecureString` decriptado, por decisão
 * explícita do spec (ferramenta local em loopback). Por isso sai com
 * `no-store` e com o flag `isSecret`, que a UI usa para mascarar por padrão.
 */
export const GET: APIRoute = async ({ params, url }) => {
  try {
    const store = await resolveParameterStore(storeContextFromUrl(url));
    const useCase = new GetParameterUseCase(store);

    return jsonResponse(await useCase.execute(requireName(params['name'])));
  } catch (error) {
    return errorResponse(error);
  }
};

/**
 * `PUT /api/parameters/example/demo/env` — grava.
 *
 * Corpo: `{ value: string, expectedVersion: number }`.
 *
 * `expectedVersion` é obrigatório. Sem ele não há como detectar que outra
 * pessoa gravou entre o GET e o PUT, e `Overwrite: true` apagaria a alteração
 * dela em silêncio.
 *
 * Desfechos que **não** são erro, e por isso não passam pelo error mapper:
 * `conflict` carrega o valor atual do store, que o cliente precisa para montar
 * o diff de três vias — e o mapper redige por padrão. Ver
 * `SaveParameterUseCase`.
 *
 * A checagem de origem e de Host acontece antes, no middleware.
 */
export const PUT: APIRoute = async ({ params, request, url }) => {
  try {
    const name = requireName(params['name']);
    const body = await parseBody(request);
    const store = await resolveParameterStore(storeContextFromUrl(url));
    const useCase = new SaveParameterUseCase(store, getBackupPort());

    const result = await useCase.execute({
      name,
      value: body.value,
      expectedVersion: body.expectedVersion,
    });

    return jsonResponse(result, httpStatusForOutcome(result.outcome));
  } catch (error) {
    return errorResponse(error);
  }
};

function requireName(routeParam: string | undefined): string {
  const name = parameterNameFromRoute(routeParam);

  if (name === '') {
    throw new InvalidParameterNameError('informe o name do parâmetro na URL');
  }

  return name;
}

interface SaveRequestBody {
  readonly value: string;
  readonly expectedVersion: number;
}

/**
 * Lê e valida a forma do corpo.
 *
 * A mensagem de erro nunca inclui o corpo recebido: ele é o valor do
 * parâmetro. Só qual campo está errado.
 */
async function parseBody(request: Request): Promise<SaveRequestBody> {
  let raw: unknown;

  try {
    raw = await request.json();
  } catch {
    throw new InvalidRequestBodyError('o corpo da requisição não é JSON válido');
  }

  if (typeof raw !== 'object' || raw === null) {
    throw new InvalidRequestBodyError('o corpo da requisição precisa ser um objeto');
  }

  const body = raw as Record<string, unknown>;
  const value = body['value'];
  const expectedVersion = body['expectedVersion'];

  if (typeof value !== 'string') {
    throw new InvalidRequestBodyError('o campo "value" precisa ser um texto');
  }

  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion)) {
    throw new InvalidRequestBodyError('o campo "expectedVersion" precisa ser um inteiro');
  }

  if (expectedVersion < 1) {
    // 0 é o sentinela de criação no port, e criação é fluxo separado da Fase 4.
    // Aceitá-lo aqui abriria exatamente o caminho de criação acidental que o
    // spec proíbe.
    throw new InvalidRequestBodyError(
      'o campo "expectedVersion" precisa ser 1 ou maior; criar parâmetro é um fluxo separado',
    );
  }

  return { value, expectedVersion };
}
