import { createContext, useContext } from 'react';
import type { JsonDocument } from '../../domain/json/JsonDocument.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import type { ValidationIssue } from '../../application/validation/validateDocument.js';

/**
 * Contexto do editor.
 *
 * O formulário é recursivo e fundo — objeto dentro de lista dentro de objeto.
 * Passar callbacks por prop em cada nível transformaria qualquer mudança de
 * assinatura em refatoração de todos os componentes.
 */

export interface EditorContextValue {
  /** Aplica uma operação de edição pura ao documento. */
  readonly edit: (apply: (document: JsonDocument) => JsonDocument) => void;
  /** `true` quando o parâmetro inteiro é `SecureString`. */
  readonly isSecret: boolean;
  /** `true` quando o valor deste caminho pode ser exibido. */
  readonly isRevealed: (path: EditPath) => boolean;
  readonly toggleRevealPath: (path: EditPath) => void;
  /** Problemas de validação indexados por `pathKey`. */
  readonly issuesByPath: ReadonlyMap<string, readonly ValidationIssue[]>;
}

const EditorContext = createContext<EditorContextValue | undefined>(undefined);

export const EditorProvider = EditorContext.Provider;

export function useEditor(): EditorContextValue {
  const value = useContext(EditorContext);

  if (value === undefined) {
    throw new Error('useEditor precisa estar dentro de EditorProvider');
  }

  return value;
}
