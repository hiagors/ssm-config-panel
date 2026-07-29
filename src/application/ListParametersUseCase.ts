import type { ParameterMetadata } from '../domain/Parameter.js';
import type { ParameterStorePort } from '../infrastructure/store/ParameterStorePort.js';

/**
 * Lista os parâmetros disponíveis, sem valores.
 *
 * Alimenta a tela inicial. Não carrega valor nenhum: listar não deve trazer
 * segredo para a memória do servidor nem para o browser.
 */
export class ListParametersUseCase {
  constructor(private readonly store: ParameterStorePort) {}

  async execute(pathPrefix?: string): Promise<ParameterMetadata[]> {
    return this.store.list({
      pathPrefix: pathPrefix === undefined || pathPrefix === '' ? undefined : pathPrefix,
      recursive: true,
    });
  }
}
