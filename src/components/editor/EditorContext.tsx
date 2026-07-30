import { createContext, useContext } from 'react';
import type { JsonDocument, JsonNodeKind } from '../../domain/json/JsonDocument.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import type { ValidationIssue } from '../../application/validation/validateDocument.js';
import type { DragState } from './useTreeView.js';

/**
 * Contexto do editor.
 *
 * A grade é achatada, mas ainda é fundo: cada linha precisa editar, expandir,
 * entrar no escopo, reordenar e anunciar. Passar tudo por prop transformaria
 * qualquer mudança de assinatura em refatoração de todas as células.
 *
 * Duas famílias de callback convivem aqui de propósito e não devem se misturar:
 * `edit` mexe no **documento** (e portanto no diff e no `dirty`); o resto mexe só
 * na **visualização**, que não pertence ao rascunho.
 */

export interface EditorContextValue {
  // ── documento ──────────────────────────────────────────────────────────────
  /** Aplica uma operação de edição pura ao documento. */
  readonly edit: (apply: (document: JsonDocument) => JsonDocument) => void;
  /** `true` quando o parâmetro inteiro é `SecureString`. */
  readonly isSecret: boolean;
  readonly isRevealed: (path: EditPath) => boolean;
  readonly toggleRevealPath: (path: EditPath) => void;
  /** Problemas de validação indexados por `pathKey`. */
  readonly issuesByPath: ReadonlyMap<string, readonly ValidationIssue[]>;

  // ── visualização ───────────────────────────────────────────────────────────
  readonly onToggleExpanded: (path: EditPath) => void;
  readonly onDrillIn: (path: EditPath) => void;
  /** Adiciona um filho no container do caminho. */
  readonly onAddChild: (path: EditPath, containerKind: JsonNodeKind) => void;
  readonly announce: (message: string) => void;

  // ── arrastar para reordenar ────────────────────────────────────────────────
  readonly drag: DragState | undefined;
  readonly onDragStart: (path: EditPath) => void;
  readonly onDragOver: (key: string) => void;
  readonly onDrop: (path: EditPath) => void;
  readonly onDragEnd: () => void;
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
