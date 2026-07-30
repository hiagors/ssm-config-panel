import { useCallback, useMemo, useState } from 'react';
import type { JsonDocument } from '../../domain/json/JsonDocument.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import { pathKey } from '../../domain/json/jsonPath.js';
import type { FlattenResult } from './treeRows.js';
import { allContainerKeys, flattenTree } from './treeRows.js';

/**
 * Estado de **visualização** da árvore.
 *
 * Separado do `useParameterDraft` de propósito. Expandido, escopo e busca não
 * pertencem ao documento: se morassem no rascunho, abrir um nó marcaria o campo
 * como `dirty`, apareceria no diff e um save "sem alterações" reescreveria o
 * parâmetro. O modelo de dados e o parser continuam intocados.
 *
 * Nada aqui é persistido — nem em `localStorage`, nem em URL. Recarregar volta à
 * árvore fechada, igual ao mascaramento de `SecureString`.
 */

export interface DragState {
  /** Linha sendo arrastada. */
  readonly fromPath: EditPath;
  /** Linha sob o cursor agora, para o indicador de destino. */
  readonly overKey: string | undefined;
}

export interface UseTreeView {
  readonly tree: FlattenResult;
  readonly scopePath: EditPath;
  readonly searchQuery: string;
  readonly isSearching: boolean;
  readonly drag: DragState | undefined;
  /** Mensagem para o `aria-live` depois de reordenar por teclado. */
  readonly announcement: string;

  readonly isExpanded: (path: EditPath) => boolean;
  readonly toggleExpanded: (path: EditPath) => void;
  readonly expandAll: () => void;
  readonly collapseAll: () => void;
  readonly setSearchQuery: (query: string) => void;
  readonly drillInto: (path: EditPath) => void;
  /** Sobe para um prefixo do escopo. `[]` volta à raiz. */
  readonly goToScope: (path: EditPath) => void;
  readonly beginDrag: (path: EditPath) => void;
  readonly dragOver: (key: string | undefined) => void;
  readonly endDrag: () => void;
  readonly announce: (message: string) => void;
}

export function useTreeView(document: JsonDocument | undefined): UseTreeView {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [scopePath, setScopePath] = useState<EditPath>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [drag, setDrag] = useState<DragState | undefined>(undefined);
  const [announcement, setAnnouncement] = useState('');

  const tree = useMemo<FlattenResult>(() => {
    if (document === undefined) {
      return {
        rows: [],
        scopeNode: undefined,
        scopeSegments: [],
        isEmptySearch: false,
        matchCount: 0,
      };
    }

    return flattenTree(document, { scopePath, expanded, searchQuery });
  }, [document, scopePath, expanded, searchQuery]);

  const toggleExpanded = useCallback((path: EditPath) => {
    const key = pathKey(path);

    setExpanded((current) => {
      const next = new Set(current);

      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }

      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (document === undefined) {
      return;
    }
    setExpanded(new Set(allContainerKeys(document, scopePath)));
  }, [document, scopePath]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  const drillInto = useCallback((path: EditPath) => {
    setScopePath(path);
    // Entrar num escopo novo começa fechado: herdar a expansão do escopo
    // anterior mostraria linhas sem relação com o que se acabou de abrir.
    setExpanded(new Set());
    setSearchQuery('');
  }, []);

  const goToScope = useCallback((path: EditPath) => {
    setScopePath(path);
    setExpanded(new Set());
    setSearchQuery('');
  }, []);

  return {
    tree,
    scopePath,
    searchQuery,
    isSearching: searchQuery.trim() !== '',
    drag,
    announcement,
    isExpanded: useCallback((path: EditPath) => expanded.has(pathKey(path)), [expanded]),
    toggleExpanded,
    expandAll,
    collapseAll,
    setSearchQuery,
    drillInto,
    goToScope,
    beginDrag: useCallback((fromPath: EditPath) => {
      setDrag({ fromPath, overKey: undefined });
    }, []),
    dragOver: useCallback((overKey: string | undefined) => {
      setDrag((current) => (current === undefined ? current : { ...current, overKey }));
    }, []),
    endDrag: useCallback(() => setDrag(undefined), []),
    announce: useCallback((message: string) => setAnnouncement(message), []),
  };
}
