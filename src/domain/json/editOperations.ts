import type {
  JsonDocument,
  JsonNode,
  JsonNodeKind,
  ObjectEntry,
} from './JsonDocument.js';
import { createEntry, createNode, scalarText } from './JsonDocument.js';
import type { EditPath } from './jsonPath.js';

/**
 * Operações de edição, todas puras: recebem documento e devolvem documento
 * novo. Nada é mutado no lugar.
 *
 * Duas invariantes que todas mantêm:
 *
 * 1. **`source` nunca muda.** Editar só troca a `root`. É o que garante que
 *    um nó limpo continue tendo de onde ser reemitido verbatim.
 * 2. **Sujeira propaga para cima, nunca para baixo.** Editar um campo marca
 *    o campo e todos os ancestrais como `dirty`, e deixa os irmãos limpos. É
 *    isso que faz o vizinho não tocado sair verbatim.
 *
 * Endereçamento é por índice (`EditPath`), não por chave: chave duplicada ou
 * vazia é estado válido durante a edição, e a validação precisa poder acusar.
 */

/** Substitui a raiz preservando `source` e o estilo detectado. */
function withRoot(document: JsonDocument, root: JsonNode): JsonDocument {
  return { source: document.source, root, style: document.style };
}

/**
 * Reconstrói o caminho até o nó alvo aplicando `transform` nele.
 *
 * Cada ancestral no caminho é recriado com `dirty: true`; irmãos são
 * reaproveitados por referência e continuam limpos.
 */
function transformAtPath(
  node: JsonNode,
  path: EditPath,
  transform: (target: JsonNode) => JsonNode,
): JsonNode {
  if (path.length === 0) {
    return transform(node);
  }

  const [index, ...rest] = path as [number, ...number[]];

  if (node.kind === 'object') {
    const entry = node.entries[index];
    if (entry === undefined) {
      return node;
    }

    const entries = [...node.entries];
    entries[index] = {
      ...entry,
      value: transformAtPath(entry.value, rest, transform),
      dirty: true,
    };

    return { ...node, entries, dirty: true };
  }

  if (node.kind === 'array') {
    const item = node.items[index];
    if (item === undefined) {
      return node;
    }

    const items = [...node.items];
    items[index] = transformAtPath(item, rest, transform);

    return { ...node, items, dirty: true };
  }

  // Caminho aponta para dentro de um escalar: nada a fazer.
  return node;
}

/** Aplica `transform` no container pai do índice endereçado por `path`. */
function transformParent(
  document: JsonDocument,
  path: EditPath,
  transform: (parent: JsonNode, index: number) => JsonNode,
): JsonDocument {
  if (path.length === 0) {
    return document;
  }

  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] as number;

  return withRoot(
    document,
    transformAtPath(document.root, parentPath, (parent) => transform(parent, index)),
  );
}

// ─── escalares ───────────────────────────────────────────────────────────────

export function setStringValue(
  document: JsonDocument,
  path: EditPath,
  value: string,
): JsonDocument {
  return withRoot(
    document,
    transformAtPath(document.root, path, (node) =>
      node.kind === 'string' ? { ...node, value, dirty: true } : node,
    ),
  );
}

/**
 * Grava o **lexema** do número.
 *
 * Recebe texto e guarda texto. Lexema inválido é aceito no modelo — a
 * validação acusa e bloqueia o save. Rejeitar aqui impediria o usuário de
 * digitar, porque `-`, `1.` e `1e` são estados intermediários legítimos de
 * quem está no meio de digitar `-1.5e3`.
 */
export function setNumberLexeme(
  document: JsonDocument,
  path: EditPath,
  raw: string,
): JsonDocument {
  return withRoot(
    document,
    transformAtPath(document.root, path, (node) =>
      node.kind === 'number' ? { ...node, raw, dirty: true } : node,
    ),
  );
}

export function setBooleanValue(
  document: JsonDocument,
  path: EditPath,
  value: boolean,
): JsonDocument {
  return withRoot(
    document,
    transformAtPath(document.root, path, (node) =>
      node.kind === 'boolean' ? { ...node, value, dirty: true } : node,
    ),
  );
}

/**
 * Troca o tipo do nó, **preservando o texto bruto** quando há onde guardá-lo.
 *
 * O tipo vem sempre do seletor ou do menu, nunca é inferido do conteúdo — é o
 * que mantém `null` e `""` distintos. Trocar para `null` produz `null`; trocar
 * para `string` produz `""` quando não havia texto.
 *
 * ── Por que preservar em vez de resetar ─────────────────────────────────────
 *
 * `"abc"` → número **não pode** descartar `"abc"`. Quem digitou o valor errado
 * quer corrigi-lo, não redigitá-lo; e o modelo já sabe representar um lexema
 * numérico inválido, porque a validação existe para acusá-lo. Resetar para `0`
 * apagaria o trabalho e ainda esconderia o erro.
 *
 * O que sobrevive, e o que não:
 *
 * | de → para | resultado                                              |
 * |-----------|--------------------------------------------------------|
 * | texto ↔ número | o texto passa inteiro; validação acusa se inválido |
 * | texto/número → booleano | `false`; o modelo não guarda booleano inválido |
 * | texto/número → null | `null`; `null` não tem conteúdo por definição |
 * | booleano/null → texto | `""`; interpolar `"true"` seria inventar conteúdo |
 * | qualquer → container | container vazio |
 * | container → qualquer | filhos descartados; a UI confirma antes |
 *
 * A linha de booleano é a única em que a regra "preserve o texto" não se
 * aplica: não existe lugar no modelo para um booleano inválido. Converter
 * `"abc"` para booleano perde o `"abc"`, e essa perda é silenciosa.
 */
export function changeNodeKind(
  document: JsonDocument,
  path: EditPath,
  kind: JsonNodeKind,
): JsonDocument {
  return withRoot(
    document,
    transformAtPath(document.root, path, (node) => {
      if (node.kind === kind) {
        return node;
      }

      // Preserva a identidade para o React não remontar a linha inteira e o
      // foco não ir para o começo do formulário.
      const replacement = { ...createNode(kind), id: node.id };
      const carried = scalarText(node);

      if (carried === undefined || carried === '') {
        return replacement;
      }

      if (replacement.kind === 'string') {
        return { ...replacement, value: carried };
      }

      if (replacement.kind === 'number') {
        return { ...replacement, raw: carried };
      }

      return replacement;
    }),
  );
}

// ─── entradas de objeto ──────────────────────────────────────────────────────

/** Renomeia mantendo a posição na lista. Reordenar no rename seria hostil. */
export function renameEntry(
  document: JsonDocument,
  path: EditPath,
  key: string,
): JsonDocument {
  return transformParent(document, path, (parent, index) => {
    if (parent.kind !== 'object') {
      return parent;
    }

    const entry = parent.entries[index];
    if (entry === undefined) {
      return parent;
    }

    const entries = [...parent.entries];
    entries[index] = { ...entry, key, dirty: true };

    return { ...parent, entries, dirty: true };
  });
}

/** Insere entrada no fim do objeto endereçado por `path`. */
export function appendEntry(
  document: JsonDocument,
  path: EditPath,
  key: string,
  kind: JsonNodeKind,
): JsonDocument {
  return withRoot(
    document,
    transformAtPath(document.root, path, (node) => {
      if (node.kind !== 'object') {
        return node;
      }
      return {
        ...node,
        entries: [...node.entries, createEntry(key, createNode(kind))],
        dirty: true,
      };
    }),
  );
}

export function removeEntry(document: JsonDocument, path: EditPath): JsonDocument {
  return transformParent(document, path, (parent, index) => {
    if (parent.kind !== 'object' || parent.entries[index] === undefined) {
      return parent;
    }

    const entries = parent.entries.filter((_, position) => position !== index);

    return { ...parent, entries, dirty: true };
  });
}

/** Move a entrada `delta` posições. Fora dos limites, não faz nada. */
export function moveEntry(
  document: JsonDocument,
  path: EditPath,
  delta: number,
): JsonDocument {
  return transformParent(document, path, (parent, index) => {
    if (parent.kind !== 'object') {
      return parent;
    }

    const entries = moveWithin([...parent.entries], index, index + delta);

    return entries === undefined ? parent : { ...parent, entries, dirty: true };
  });
}

// ─── itens de lista ──────────────────────────────────────────────────────────

export function appendItem(
  document: JsonDocument,
  path: EditPath,
  kind: JsonNodeKind,
): JsonDocument {
  return withRoot(
    document,
    transformAtPath(document.root, path, (node) => {
      if (node.kind !== 'array') {
        return node;
      }
      return { ...node, items: [...node.items, createNode(kind)], dirty: true };
    }),
  );
}

export function removeItem(document: JsonDocument, path: EditPath): JsonDocument {
  return transformParent(document, path, (parent, index) => {
    if (parent.kind !== 'array' || parent.items[index] === undefined) {
      return parent;
    }

    const items = parent.items.filter((_, position) => position !== index);

    return { ...parent, items, dirty: true };
  });
}

export function moveItem(
  document: JsonDocument,
  path: EditPath,
  delta: number,
): JsonDocument {
  return transformParent(document, path, (parent, index) => {
    if (parent.kind !== 'array') {
      return parent;
    }

    const items = moveWithin([...parent.items], index, index + delta);

    return items === undefined ? parent : { ...parent, items, dirty: true };
  });
}

/** Move um elemento; devolve `undefined` quando o destino é inválido. */
function moveWithin<T>(list: T[], from: number, to: number): T[] | undefined {
  if (from < 0 || from >= list.length || to < 0 || to >= list.length || from === to) {
    return undefined;
  }

  const [moved] = list.splice(from, 1);

  if (moved === undefined) {
    return undefined;
  }

  list.splice(to, 0, moved);

  return list;
}

/** Entradas de um objeto, ou lista vazia. Conveniência para a UI. */
export function entriesOf(node: JsonNode): readonly ObjectEntry[] {
  return node.kind === 'object' ? node.entries : [];
}

/** Itens de uma lista, ou lista vazia. Conveniência para a UI. */
export function itemsOf(node: JsonNode): readonly JsonNode[] {
  return node.kind === 'array' ? node.items : [];
}
