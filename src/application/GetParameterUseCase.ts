import type { ParameterMetadata } from '../domain/Parameter.js';
import { isSecret, valueSizeInBytes } from '../domain/Parameter.js';
import { TIER_VALUE_LIMIT_BYTES } from '../domain/Parameter.js';
import type { ParameterStorePort } from '../infrastructure/store/ParameterStorePort.js';

/**
 * Lê um parâmetro e classifica o valor para a UI.
 *
 * O use case decide se o valor é JSON editável ou texto cru, mas não tenta
 * "consertar" JSON inválido — o spec é explícito: avisar, não adivinhar.
 */

export interface GetParameterResult {
  readonly metadata: ParameterMetadata;
  readonly value: string;
  /** `true` quando o valor é JSON válido e o editor estruturado se aplica. */
  readonly isValidJson: boolean;
  /**
   * Motivo do JSON inválido, seguro para exibir.
   *
   * Nunca é a mensagem do `JSON.parse`: ela embute um trecho do texto de
   * entrada, que pode ser um `SecureString` decriptado. Só a posição.
   */
  readonly jsonError?: string | undefined;
  /** `true` quando o valor deve chegar mascarado na UI. */
  readonly isSecret: boolean;
  readonly sizeInBytes: number;
  readonly sizeLimitInBytes: number;
}

export class GetParameterUseCase {
  constructor(private readonly store: ParameterStorePort) {}

  async execute(name: string): Promise<GetParameterResult> {
    const parameter = await this.store.get(name);
    const { isValidJson, jsonError } = inspectJson(parameter.value);

    return {
      metadata: parameter.metadata,
      value: parameter.value,
      isValidJson,
      jsonError,
      isSecret: isSecret(parameter.metadata),
      sizeInBytes: valueSizeInBytes(parameter.value),
      sizeLimitInBytes: TIER_VALUE_LIMIT_BYTES[parameter.metadata.tier],
    };
  }
}

/**
 * Verifica se o texto é JSON válido sem repassar a mensagem do parser.
 *
 * `JSON.parse('{"token":"sk-live-abc"')` lança uma mensagem que inclui o
 * trecho `{"token":"sk-live-abc"`. Extraímos apenas a posição do erro.
 */
export function inspectJson(value: string): {
  isValidJson: boolean;
  jsonError?: string | undefined;
} {
  try {
    JSON.parse(value);
    return { isValidJson: true, jsonError: undefined };
  } catch (error) {
    return { isValidJson: false, jsonError: describeJsonError(error) };
  }
}

function describeJsonError(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  const position = /position (\d+)/.exec(message)?.[1];
  const line = /line (\d+)/.exec(message)?.[1];

  if (line !== undefined) {
    return `JSON inválido na linha ${line}.`;
  }
  if (position !== undefined) {
    return `JSON inválido na posição ${position}.`;
  }
  return 'JSON inválido.';
}
