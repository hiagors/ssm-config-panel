import { useCallback, useMemo, useReducer } from 'react';
import type { JsonDocument } from '../../domain/json/JsonDocument.js';
import type { JsonParseError } from '../../domain/json/parseJsonDocument.js';
import { parseJsonDocument } from '../../domain/json/parseJsonDocument.js';
import { serializeJsonDocument } from '../../domain/json/serializeJsonDocument.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import { pathKey } from '../../domain/json/jsonPath.js';

/**
 * Estado do rascunho.
 *
 * ── A invariante da base ────────────────────────────────────────────────────
 *
 * `base.text` é um **snapshot imutável** do texto que veio do store, gravado
 * uma vez na montagem e nunca reescrito. Não é derivado do documento nem dos
 * spans.
 *
 * Isso não é detalhe. `JsonDocument.source` parece ser a mesma coisa e não é:
 * quando o usuário edita a aba JSON cru, o documento é reparseado e passa a
 * ter `source` igual ao texto digitado, com todos os nós limpos. Se o diff
 * usasse `document.source` como base, ele compararia o texto digitado consigo
 * mesmo e daria vazio — escondendo exatamente a alteração que o usuário
 * acabou de fazer. `base.text` fica de fora dessa cadeia de propósito.
 *
 * `base.version` anda junto: é a versão lida no GET, e é ela que a Fase 2b
 * envia no save para detectar lost update. Base e versão precisam vir do
 * mesmo GET, senão a checagem de concorrência compara coisas de momentos
 * diferentes.
 *
 * ── Nada disso vai para disco ───────────────────────────────────────────────
 *
 * O rascunho vive só aqui, no estado do React. Sem `localStorage`, sem
 * cookie, sem query string — o valor pode ser `SecureString` decriptado.
 */

export interface DraftBase {
  /** Texto exato carregado do store. Imutável. */
  readonly text: string;
  /** Versão lida no mesmo GET que trouxe `text`. */
  readonly version: number;
}

/**
 * Conteúdo do rascunho.
 *
 * `structured` quando o texto é JSON parseável e o documento é a fonte da
 * verdade. `rawInvalid` quando não é: aí o **texto** é a fonte da verdade e o
 * formulário fica indisponível. Nunca convertemos nem "consertamos" — o spec
 * é explícito.
 */
export type DraftContent =
  | { readonly kind: 'structured'; readonly document: JsonDocument }
  | { readonly kind: 'rawInvalid'; readonly text: string; readonly error: JsonParseError };

export type DraftTab = 'structured' | 'raw';

export interface DraftState {
  readonly base: DraftBase;
  readonly tab: DraftTab;
  readonly content: DraftContent;
  /** Revelar tudo, global. Sempre começa `false` em parâmetro secreto. */
  readonly revealAll: boolean;
  /** Caminhos revelados individualmente. Chave de `pathKey`. */
  readonly revealedPaths: ReadonlySet<string>;
}

export type DraftAction =
  | { readonly type: 'SELECT_TAB'; readonly tab: DraftTab }
  | { readonly type: 'EDIT'; readonly apply: (document: JsonDocument) => JsonDocument }
  | { readonly type: 'SET_RAW'; readonly text: string }
  | { readonly type: 'TOGGLE_REVEAL_ALL' }
  | { readonly type: 'TOGGLE_REVEAL_PATH'; readonly path: EditPath }
  | { readonly type: 'DISCARD' };

/** Monta o estado inicial a partir do que o GET trouxe. */
export function initialDraftState(loadedText: string, loadedVersion: number): DraftState {
  return {
    base: { text: loadedText, version: loadedVersion },
    tab: 'structured',
    content: contentFromText(loadedText),
    revealAll: false,
    revealedPaths: new Set(),
  };
}

function contentFromText(text: string): DraftContent {
  const result = parseJsonDocument(text);

  return result.ok
    ? { kind: 'structured', document: result.document }
    : { kind: 'rawInvalid', text, error: result.error };
}

export function draftReducer(state: DraftState, action: DraftAction): DraftState {
  switch (action.type) {
    case 'SELECT_TAB': {
      // A aba estruturada não existe enquanto o JSON estiver inválido.
      if (action.tab === 'structured' && state.content.kind === 'rawInvalid') {
        return state;
      }
      return { ...state, tab: action.tab };
    }

    case 'EDIT': {
      if (state.content.kind !== 'structured') {
        return state;
      }
      return {
        ...state,
        content: { kind: 'structured', document: action.apply(state.content.document) },
      };
    }

    case 'SET_RAW': {
      // Reparseia a cada tecla. Válido volta para o formulário; inválido
      // mantém o texto do usuário intacto e explica o motivo.
      return { ...state, content: contentFromText(action.text) };
    }

    case 'TOGGLE_REVEAL_ALL': {
      const revealAll = !state.revealAll;
      // Ao ocultar tudo, as revelações individuais também caem: "ocultar"
      // precisa realmente ocultar.
      return { ...state, revealAll, revealedPaths: revealAll ? state.revealedPaths : new Set() };
    }

    case 'TOGGLE_REVEAL_PATH': {
      const key = pathKey(action.path);
      const revealedPaths = new Set(state.revealedPaths);

      if (revealedPaths.has(key)) {
        revealedPaths.delete(key);
      } else {
        revealedPaths.add(key);
      }

      return { ...state, revealedPaths };
    }

    case 'DISCARD': {
      return {
        ...state,
        content: contentFromText(state.base.text),
        tab: state.content.kind === 'rawInvalid' ? state.tab : 'structured',
      };
    }
  }
}

export interface UseParameterDraft {
  readonly state: DraftState;
  /** Texto que seria gravado agora. */
  readonly currentText: string;
  /** `true` quando o texto atual difere da base. Comparação textual direta. */
  readonly isDirty: boolean;
  readonly canUseStructuredTab: boolean;
  readonly selectTab: (tab: DraftTab) => void;
  readonly edit: (apply: (document: JsonDocument) => JsonDocument) => void;
  readonly setRaw: (text: string) => void;
  readonly toggleRevealAll: () => void;
  readonly toggleRevealPath: (path: EditPath) => void;
  readonly discard: () => void;
  /** `true` quando o valor deste caminho pode ser exibido. */
  readonly isRevealed: (path: EditPath) => boolean;
}

export function useParameterDraft(
  loadedText: string,
  loadedVersion: number,
  isSecret: boolean,
): UseParameterDraft {
  const [state, dispatch] = useReducer(
    draftReducer,
    undefined,
    () => initialDraftState(loadedText, loadedVersion),
  );

  const currentText = useMemo(() => draftText(state), [state]);

  const isRevealed = useCallback(
    (path: EditPath) => {
      // Parâmetro que não é SecureString não tem nada a mascarar.
      if (!isSecret) {
        return true;
      }
      return state.revealAll || state.revealedPaths.has(pathKey(path));
    },
    [isSecret, state.revealAll, state.revealedPaths],
  );

  return {
    state,
    currentText,
    isDirty: currentText !== state.base.text,
    canUseStructuredTab: state.content.kind === 'structured',
    selectTab: useCallback((tab: DraftTab) => dispatch({ type: 'SELECT_TAB', tab }), []),
    edit: useCallback(
      (apply: (document: JsonDocument) => JsonDocument) => dispatch({ type: 'EDIT', apply }),
      [],
    ),
    setRaw: useCallback((text: string) => dispatch({ type: 'SET_RAW', text }), []),
    toggleRevealAll: useCallback(() => dispatch({ type: 'TOGGLE_REVEAL_ALL' }), []),
    toggleRevealPath: useCallback(
      (path: EditPath) => dispatch({ type: 'TOGGLE_REVEAL_PATH', path }),
      [],
    ),
    discard: useCallback(() => dispatch({ type: 'DISCARD' }), []),
    isRevealed,
  };
}

/** Texto atual do rascunho, seja ele vindo do documento ou do texto cru. */
export function draftText(state: DraftState): string {
  return state.content.kind === 'structured'
    ? serializeJsonDocument(state.content.document)
    : state.content.text;
}
