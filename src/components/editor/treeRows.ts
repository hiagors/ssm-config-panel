import type { JsonDocument, JsonNode, JsonNodeKind } from '../../domain/json/JsonDocument.js';
import { childCount } from '../../domain/json/JsonDocument.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import {
  childPath,
  dottedPath,
  nodeAtPath,
  normalizePathQuery,
  pathKey,
  pathSegments,
} from '../../domain/json/jsonPath.js';

/**
 * Achatamento da árvore em lista de linhas.
 *
 * É a peça que troca **recursão de render** por **recursão de dados**, e é o que
 * conserta o bug de layout. Antes, cada nível de aninhamento era um componente
 * que abria um container próprio, com um grid novo dentro de uma largura já
 * estreitada — a coluna de valor era recalculada a cada nível e, em três níveis,
 * sobrava ~30px para o input.
 *
 * Com a árvore achatada, todas as linhas são irmãs na mesma grade. A coluna de
 * valor é medida **uma vez**, contra a largura total. A profundidade deixa de
 * ser dimensão de layout e vira só `padding-left` dentro da célula da chave.
 *
 * Função pura, sem React: dá para testar profundidade, escopo e filtro sem
 * renderizar nada.
 */

/**
 * Profundidade máxima renderizada em linha.
 *
 * Acima disso o header não expande: entra no escopo (drill-in). Três níveis é o
 * limite em que a indentação ainda cabe na coluna de 190px sem comer o nome da
 * chave.
 */
export const MAX_INLINE_DEPTH = 3;

/** Uma linha da grade. Tudo que a linha precisa saber para se desenhar. */
export interface TreeRow {
  /** Identidade estável: `id` da entrada, para reordenar sem remontar. */
  readonly id: string;
  readonly path: EditPath;
  /** Chave de `path`, para lookup em `Set`/`Map`. */
  readonly key: string;
  /** Profundidade **relativa ao escopo atual**. Só vira indentação. */
  readonly depth: number;
  /** Chave do objeto, ou o índice em lista. */
  readonly label: string;
  /** `true` quando o pai é lista: a coluna de chave não é editável. */
  readonly isArrayItem: boolean;
  readonly node: JsonNode;
  readonly kind: JsonNodeKind;
  readonly isContainer: boolean;
  readonly childCount: number;
  readonly isExpanded: boolean;
  /**
   * `true` quando clicar no header entra no escopo em vez de expandir.
   *
   * Acontece na fronteira de `MAX_INLINE_DEPTH`: expandir ali produziria linhas
   * indentadas além do que a coluna de chave suporta.
   */
  readonly drillInOnly: boolean;
  /** Caminho com pontos, para tooltip e para o anúncio de reordenação. */
  readonly dottedPath: string;
  /** Índice dentro do pai, e total de irmãos — para o `aria-live` do reordenar. */
  readonly indexInParent: number;
  readonly siblingCount: number;
}

export interface FlattenOptions {
  /** Raiz da visualização. Vazio = raiz do documento. */
  readonly scopePath: EditPath;
  /** Caminhos expandidos, por `pathKey`. */
  readonly expanded: ReadonlySet<string>;
  /** Texto do campo de busca. Vazio desliga o filtro. */
  readonly searchQuery: string;
}

export interface FlattenResult {
  readonly rows: readonly TreeRow[];
  /** Nó no escopo atual; `undefined` se o escopo não existe mais. */
  readonly scopeNode: JsonNode | undefined;
  /** Segmentos do escopo, para o breadcrumb. */
  readonly scopeSegments: readonly string[];
  /** `true` quando a busca está ativa e não encontrou nada. */
  readonly isEmptySearch: boolean;
  /** Quantas linhas casaram, quando a busca está ativa. */
  readonly matchCount: number;
}

/**
 * Produz as linhas visíveis.
 *
 * Com busca ativa, a expansão manual é ignorada: o que decide o que aparece é o
 * casamento. Um nó só é mostrado se ele casa ou se é ancestral de quem casa —
 * senão o resultado da busca viria escondido dentro de um pai fechado.
 */
export function flattenTree(
  document: JsonDocument,
  options: FlattenOptions,
): FlattenResult {
  const scopeNode = nodeAtPath(document.root, options.scopePath);
  const scopeSegments = pathSegments(document.root, options.scopePath);

  if (scopeNode === undefined) {
    return { rows: [], scopeNode: undefined, scopeSegments, isEmptySearch: false, matchCount: 0 };
  }

  const query = normalizePathQuery(options.searchQuery);
  const isSearching = query.length > 0;

  // Com busca, precisamos saber de antemano quais caminhos ficam visíveis: um
  // ancestral só entra se algum descendente casa.
  const visibleUnderSearch = isSearching
    ? collectSearchMatches(options.scopePath, scopeNode, query)
    : undefined;

  const rows: TreeRow[] = [];

  walk(document, options.scopePath, scopeNode, 0, {
    expanded: options.expanded,
    visibleUnderSearch,
    rows,
  });

  return {
    rows,
    scopeNode,
    scopeSegments,
    isEmptySearch: isSearching && rows.length === 0,
    matchCount: visibleUnderSearch?.matched.size ?? rows.length,
  };
}

interface WalkContext {
  readonly expanded: ReadonlySet<string>;
  readonly visibleUnderSearch: SearchVisibility | undefined;
  readonly rows: TreeRow[];
}

function walk(
  document: JsonDocument,
  path: EditPath,
  node: JsonNode,
  depth: number,
  context: WalkContext,
): void {
  const children = childEntriesOf(node);

  for (const child of children) {
    const currentPath = childPath(path, child.index);
    const key = pathKey(currentPath);

    if (context.visibleUnderSearch !== undefined && !context.visibleUnderSearch.visible.has(key)) {
      continue;
    }

    const isContainer = child.node.kind === 'object' || child.node.kind === 'array';
    const drillInOnly = isContainer && depth + 1 >= MAX_INLINE_DEPTH;

    // Com busca ativa a expansão manual não decide nada: o filtro já escolheu o
    // que aparece, e respeitar `expanded` esconderia resultados.
    const isExpanded =
      isContainer &&
      !drillInOnly &&
      (context.visibleUnderSearch !== undefined || context.expanded.has(key));

    context.rows.push({
      id: child.id,
      path: currentPath,
      key,
      depth,
      label: child.label,
      isArrayItem: child.isArrayItem,
      node: child.node,
      kind: child.node.kind,
      isContainer,
      childCount: childCount(child.node),
      isExpanded,
      drillInOnly,
      dottedPath: dottedPath(document.root, currentPath),
      indexInParent: child.index,
      siblingCount: children.length,
    });

    if (isExpanded) {
      walk(document, currentPath, child.node, depth + 1, context);
    }
  }
}

interface ChildDescriptor {
  readonly id: string;
  readonly index: number;
  readonly label: string;
  readonly node: JsonNode;
  readonly isArrayItem: boolean;
}

/** Filhos de um container, normalizados. Escalar não tem filhos. */
function childEntriesOf(node: JsonNode): ChildDescriptor[] {
  if (node.kind === 'object') {
    return node.entries.map((entry, index) => ({
      id: entry.id,
      index,
      label: entry.key,
      node: entry.value,
      isArrayItem: false,
    }));
  }

  if (node.kind === 'array') {
    return node.items.map((item, index) => ({
      id: item.id,
      index,
      label: `[${index}]`,
      node: item,
      isArrayItem: true,
    }));
  }

  return [];
}

interface SearchVisibility {
  /** Caminhos que casaram diretamente. */
  readonly matched: ReadonlySet<string>;
  /** Casados mais os ancestrais deles, que precisam aparecer para dar contexto. */
  readonly visible: ReadonlySet<string>;
}

/**
 * Descobre o que a busca torna visível.
 *
 * O casamento é **por segmento**: cada segmento da consulta tem de ser
 * substring do segmento correspondente do caminho, sem atravessar separador.
 * Assim `conn.bank` casa `db_connections.banking` mas `connections.bank` não
 * casa `db_connections.banking` pela metade errada — e, principalmente,
 * `db.min` não casa `db_connections.pool.min`, porque os segmentos precisam ser
 * **consecutivos**.
 */
function collectSearchMatches(
  scopePath: EditPath,
  scopeNode: JsonNode,
  query: readonly string[],
): SearchVisibility {
  const matched = new Set<string>();
  const visible = new Set<string>();

  /** Marca a subárvore inteira: quem casa mostra o próprio conteúdo. */
  const markSubtree = (path: EditPath, node: JsonNode): void => {
    for (const child of childEntriesOf(node)) {
      const currentPath = childPath(path, child.index);
      visible.add(pathKey(currentPath));
      markSubtree(currentPath, child.node);
    }
  };

  /**
   * Uma passada. Devolve `true` quando a subárvore contém algum casamento —
   * é assim que o ancestral fica visível sem precisar de uma varredura extra.
   */
  const visit = (path: EditPath, node: JsonNode, ancestors: readonly string[]): boolean => {
    let subtreeHasMatch = false;

    for (const child of childEntriesOf(node)) {
      const currentPath = childPath(path, child.index);
      const key = pathKey(currentPath);
      // Índice de lista entra como número puro, igual a `pathSegments`.
      const segment = child.isArrayItem ? String(child.index) : child.label;
      const segments = [...ancestors, segment.toLowerCase()];

      const selfMatches = matchesSegmentWindow(segments, query);
      const descendantMatches = visit(currentPath, child.node, segments);

      if (selfMatches) {
        matched.add(key);
        // Quem busca `db_connections.banking` quer ver os campos de dentro.
        markSubtree(currentPath, child.node);
      }

      if (selfMatches || descendantMatches) {
        visible.add(key);
        subtreeHasMatch = true;
      }
    }

    return subtreeHasMatch;
  };

  visit(scopePath, scopeNode, []);

  return { matched, visible };
}

/**
 * `true` quando existe uma janela consecutiva de segmentos que casa a consulta.
 *
 * Cada segmento da consulta precisa ser substring do segmento correspondente —
 * substring **dentro** do segmento, nunca atravessando o separador.
 */
export function matchesSegmentWindow(
  segments: readonly string[],
  query: readonly string[],
): boolean {
  if (query.length === 0) {
    return true;
  }

  if (query.length > segments.length) {
    return false;
  }

  for (let start = 0; start + query.length <= segments.length; start += 1) {
    let allMatch = true;

    for (let offset = 0; offset < query.length; offset += 1) {
      const segment = segments[start + offset] as string;
      const term = query[offset] as string;

      if (!segment.includes(term)) {
        allMatch = false;
        break;
      }
    }

    if (allMatch) {
      return true;
    }
  }

  return false;
}

/** Todos os caminhos de container abaixo do escopo, para "expandir tudo". */
export function allContainerKeys(document: JsonDocument, scopePath: EditPath): string[] {
  const scopeNode = nodeAtPath(document.root, scopePath);

  if (scopeNode === undefined) {
    return [];
  }

  const keys: string[] = [];

  const visit = (path: EditPath, node: JsonNode, depth: number): void => {
    if (depth >= MAX_INLINE_DEPTH) {
      return;
    }

    for (const child of childEntriesOf(node)) {
      const currentPath = childPath(path, child.index);

      if (child.node.kind === 'object' || child.node.kind === 'array') {
        keys.push(pathKey(currentPath));
        visit(currentPath, child.node, depth + 1);
      }
    }
  };

  visit(scopePath, scopeNode, 0);

  return keys;
}
