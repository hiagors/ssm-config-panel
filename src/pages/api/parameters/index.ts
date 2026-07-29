import type { APIRoute } from 'astro';
import { ListParametersUseCase } from '../../../application/ListParametersUseCase.js';
import { getParameterStore } from '../../../infrastructure/store/index.js';
import { errorResponse, jsonResponse } from '../_http.js';

export const prerender = false;

/**
 * `GET /api/parameters?prefix=/example`
 *
 * Devolve apenas metadados. Nenhum valor de parâmetro trafega aqui.
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    const useCase = new ListParametersUseCase(getParameterStore());
    const prefix = url.searchParams.get('prefix') ?? undefined;
    const parameters = await useCase.execute(prefix);

    return jsonResponse({ parameters });
  } catch (error) {
    return errorResponse(error);
  }
};
