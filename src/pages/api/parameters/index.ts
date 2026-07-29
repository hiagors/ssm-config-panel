import type { APIRoute } from 'astro';
import { ListParametersUseCase } from '../../../application/ListParametersUseCase.js';
import { storeContextFromUrl } from '../../../infrastructure/http/storeContext.js';
import { resolveParameterStore } from '../../../infrastructure/store/index.js';
import { errorResponse, jsonResponse } from '../_http.js';

export const prerender = false;

/**
 * `GET /api/parameters?prefix=/example&profile=meu-profile`
 *
 * Devolve apenas metadados. Nenhum valor de parâmetro trafega aqui — no driver
 * `aws` isso é `DescribeParameters`, que por construção não devolve valores.
 *
 * O prefixo é opcional no driver local e **obrigatório** no `aws`: varrer uma
 * conta de produção inteira é lento, caro e sujeito a throttling.
 */
export const GET: APIRoute = async ({ url }) => {
  try {
    const store = await resolveParameterStore(storeContextFromUrl(url));
    const useCase = new ListParametersUseCase(store);
    const prefix = url.searchParams.get('prefix') ?? undefined;

    return jsonResponse({ parameters: await useCase.execute(prefix) });
  } catch (error) {
    return errorResponse(error);
  }
};
