import type { APIRoute } from 'astro';
import { GetParameterUseCase } from '../../../application/GetParameterUseCase.js';
import { InvalidParameterNameError } from '../../../domain/errors.js';
import { getParameterStore } from '../../../infrastructure/store/index.js';
import { errorResponse, jsonResponse, parameterNameFromRoute } from '../_http.js';

export const prerender = false;

/**
 * `GET /api/parameters/example/demo/env` -> parâmetro `/example/demo/env`.
 *
 * A resposta pode conter valor de `SecureString` decriptado, por decisão
 * explícita do spec (ferramenta local em loopback). Por isso sai com
 * `no-store` e com o flag `isSecret`, que a UI usa para mascarar por padrão.
 */
export const GET: APIRoute = async ({ params }) => {
  try {
    const name = parameterNameFromRoute(params['name']);

    if (name === '') {
      throw new InvalidParameterNameError('informe o name do parâmetro na URL');
    }

    const useCase = new GetParameterUseCase(getParameterStore());

    return jsonResponse(await useCase.execute(name));
  } catch (error) {
    return errorResponse(error);
  }
};
