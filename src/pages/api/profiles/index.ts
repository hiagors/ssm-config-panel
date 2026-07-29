import type { APIRoute } from 'astro';
import { ListProfilesUseCase } from '../../../application/ListProfilesUseCase.js';
import { getSsoAuth, preselectedProfileName } from '../../../infrastructure/store/index.js';
import { errorResponse, jsonResponse } from '../_http.js';

export const prerender = false;

/**
 * `GET /api/profiles` — profiles disponíveis e estado de cada sessão.
 *
 * Nenhum segredo na resposta: só nome, conta, role, região e estado. Conta e
 * role não são segredo e são justamente o que o usuário precisa ver para saber
 * sob qual identidade vai operar.
 *
 * A leitura é offline — inspeciona `~/.aws/config` e o cache de token em
 * `~/.aws/sso/cache`, sem chamada de rede. Serve para a UI fazer polling
 * durante o login sem custo.
 */
export const GET: APIRoute = async () => {
  try {
    const useCase = new ListProfilesUseCase(getSsoAuth());

    return jsonResponse(await useCase.execute(preselectedProfileName()));
  } catch (error) {
    return errorResponse(error);
  }
};
