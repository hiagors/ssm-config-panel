import type { ParameterMetadata, ParameterTier } from '../domain/Parameter.js';
import {
  ParameterNotFoundError,
  VersionMismatchError,
  isAppError,
} from '../domain/errors.js';
import { parseJsonDocument } from '../domain/json/parseJsonDocument.js';
import type { ParameterStorePort } from '../infrastructure/store/ParameterStorePort.js';
import type { ValidationIssue } from './validation/validateDocument.js';
import { validateDocument } from './validation/validateDocument.js';

/**
 * Grava um parâmetro, com as duas guardas que o spec exige.
 *
 * ── Por que o resultado não é exceção ───────────────────────────────────────
 *
 * O conflito de lost update **precisa** carregar o valor atual do store: sem
 * ele o cliente não tem como montar o diff de três vias. E o error mapper
 * central redige por padrão, de propósito — nada além de mensagem curada
 * atravessa a fronteira HTTP.
 *
 * Se conflito fosse exceção, uma das duas coisas quebraria: ou a redação
 * deixaria passar o valor, ou o diff não teria o que mostrar. Modelar como
 * **resultado** resolve os dois: o valor viaja pelo helper normal de resposta
 * JSON, com `no-store`, e a invariante "valor de parâmetro nunca entra em
 * objeto de erro" fica intacta.
 *
 * ── O que esta camada garante ───────────────────────────────────────────────
 *
 * 1. **Nunca cria.** Se o parâmetro não existe, aborta. `PutParameter` com
 *    `Overwrite: true` criaria, e nesse caso não haveria original de onde
 *    herdar `Type`, `Tier` e `KeyId`.
 * 2. **Nunca sobrescreve às cegas.** Relê e compara a versão antes de gravar.
 * 3. **Preserva os metadados** do original, sempre. O cliente não escolhe
 *    `Type`, `Tier` nem `KeyId` — nem por engano, nem de propósito.
 * 4. **Revalida no servidor.** O cliente já valida, mas validação de cliente é
 *    conveniência, não controle.
 *
 * Honestidade sobre o limite: reler-comparar-gravar não é atômico, e o SSM não
 * tem put condicional. A janela cai de "todo o tempo de edição" para os
 * milissegundos entre o re-read e a gravação, mas não zera.
 */

export interface SaveParameterInput {
  readonly name: string;
  readonly value: string;
  /** Versão de que a edição partiu, lida no GET que abriu o editor. */
  readonly expectedVersion: number;
}

export type SaveOutcome =
  | {
      readonly outcome: 'saved';
      readonly version: number;
      readonly tier: ParameterTier;
    }
  | {
      readonly outcome: 'conflict';
      readonly expectedVersion: number;
      readonly currentVersion: number;
      /** Valor atual no store, necessário para o diff de três vias. */
      readonly currentValue: string;
      readonly currentMetadata: ParameterMetadata;
    }
  | {
      readonly outcome: 'notFound';
      readonly name: string;
    }
  | {
      readonly outcome: 'invalid';
      readonly issues: readonly ValidationIssue[];
    };

export class SaveParameterUseCase {
  constructor(private readonly store: ParameterStorePort) {}

  async execute(input: SaveParameterInput): Promise<SaveOutcome> {
    // 1. Relê. Também é o que descobre se o parâmetro existe.
    let current;
    try {
      current = await this.store.get(input.name);
    } catch (error) {
      if (error instanceof ParameterNotFoundError) {
        return { outcome: 'notFound', name: input.name };
      }
      throw error;
    }

    // 2. Valida contra o tier do parâmetro real, não contra um tier informado
    //    pelo cliente.
    const invalid = this.validate(input.value, current.metadata.tier);
    if (invalid !== undefined) {
      return invalid;
    }

    // 3. Compara versões antes de gravar.
    if (current.metadata.version !== input.expectedVersion) {
      return this.conflict(input.expectedVersion, current.metadata, current.value);
    }

    // 4. Grava preservando os metadados do original. O `expectedVersion` faz o
    //    adapter checar de novo, mais perto do disco.
    try {
      const result = await this.store.put(input.name, input.value, {
        type: current.metadata.type,
        tier: current.metadata.tier,
        keyId: current.metadata.keyId,
        description: current.metadata.description,
        expectedVersion: input.expectedVersion,
      });

      return { outcome: 'saved', version: result.version, tier: result.tier };
    } catch (error) {
      // Alguém gravou entre o passo 3 e o 4. A checagem do adapter pegou.
      if (error instanceof VersionMismatchError) {
        return this.reReadForConflict(input);
      }
      if (error instanceof ParameterNotFoundError) {
        return { outcome: 'notFound', name: input.name };
      }
      throw error;
    }
  }

  /**
   * Valida o texto recebido: JSON parseável, chaves, números e tamanho.
   *
   * Devolve `undefined` quando está tudo certo.
   */
  private validate(value: string, tier: ParameterTier): SaveOutcome | undefined {
    const parsed = parseJsonDocument(value);

    if (!parsed.ok) {
      // Nunca repassa trecho do conteúdo: só posição. Ver `parseJsonDocument`.
      return {
        outcome: 'invalid',
        issues: [
          {
            severity: 'error',
            code: 'INVALID_JSON',
            path: [],
            label: '(documento)',
            message: `O valor não é JSON válido. ${parsed.error.message}`,
          },
        ],
      };
    }

    const validation = validateDocument(parsed.document, tier);

    if (!validation.canSave) {
      return {
        outcome: 'invalid',
        issues: validation.issues.filter((issue) => issue.severity === 'error'),
      };
    }

    return undefined;
  }

  /** Relê para montar o conflito com o estado mais recente que existe. */
  private async reReadForConflict(input: SaveParameterInput): Promise<SaveOutcome> {
    try {
      const latest = await this.store.get(input.name);
      return this.conflict(input.expectedVersion, latest.metadata, latest.value);
    } catch (error) {
      if (error instanceof ParameterNotFoundError) {
        return { outcome: 'notFound', name: input.name };
      }
      if (isAppError(error)) {
        throw error;
      }
      throw error;
    }
  }

  private conflict(
    expectedVersion: number,
    metadata: ParameterMetadata,
    value: string,
  ): SaveOutcome {
    return {
      outcome: 'conflict',
      expectedVersion,
      currentVersion: metadata.version,
      currentValue: value,
      currentMetadata: metadata,
    };
  }
}

/** Status HTTP de cada desfecho. A rota não decide isso na mão. */
export function httpStatusForOutcome(outcome: SaveOutcome['outcome']): number {
  switch (outcome) {
    case 'saved':
      return 200;
    case 'invalid':
      return 422;
    case 'notFound':
      return 404;
    case 'conflict':
      return 409;
  }
}
