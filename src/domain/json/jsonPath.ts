import type { JsonDocument, JsonNode, ObjectEntry } from './JsonDocument.js';

/**
 * Dois conceitos de caminho, de propósito.
 *
 * `EditPath` endereça por **índice**: índice da entrada no objeto, índice do
 * item na lista. É o que as operações de edição usam, porque chave pode estar
 * duplicada ou vazia — endereçar por nome seria ambíguo justamente nos casos
 * que a validação precisa acusar.
 *
 * `DisplayPath` é o texto legível (`/DATABASE/pool/min`) usado em mensagem de
 * validação e, na Fase 2b, no diff por caminho. Derivado do `EditPath`.
 */

/** Índices da raiz até o nó. Objeto e lista usam a mesma representação. */
export type EditPath = readonly number[];

export const ROOT_PATH: EditPath = [];

/** Chave estável de um caminho, para usar em `Set` e `Map`. */
export function pathKey(path: EditPath): string {
  return path.join('.');
}

export function childPath(path: EditPath, index: number): EditPath {
  return [...path, index];
}

/** Resolve o nó no caminho, ou `undefined` se o caminho não existir. */
export function nodeAtPath(root: JsonNode, path: EditPath): JsonNode | undefined {
  let current: JsonNode = root;

  for (const index of path) {
    if (current.kind === 'object') {
      const entry = current.entries[index];
      if (entry === undefined) {
        return undefined;
      }
      current = entry.value;
      continue;
    }

    if (current.kind === 'array') {
      const item = current.items[index];
      if (item === undefined) {
        return undefined;
      }
      current = item;
      continue;
    }

    return undefined;
  }

  return current;
}

/** Resolve a entrada de objeto no caminho, se o caminho apontar para uma. */
export function entryAtPath(root: JsonNode, path: EditPath): ObjectEntry | undefined {
  if (path.length === 0) {
    return undefined;
  }

  const parentPath = path.slice(0, -1);
  const index = path[path.length - 1] as number;
  const parent = nodeAtPath(root, parentPath);

  if (parent?.kind !== 'object') {
    return undefined;
  }

  return parent.entries[index];
}

/**
 * Texto legível do caminho.
 *
 * Objeto contribui `/chave`, lista contribui `[índice]`. Chave vazia aparece
 * como `/(chave vazia)` para a mensagem de validação fazer sentido.
 */
export function displayPath(root: JsonNode, path: EditPath): string {
  let current: JsonNode = root;
  let out = '';

  for (const index of path) {
    if (current.kind === 'object') {
      const entry = current.entries[index];
      if (entry === undefined) {
        return `${out}/?`;
      }
      out += `/${entry.key === '' ? '(chave vazia)' : entry.key}`;
      current = entry.value;
      continue;
    }

    if (current.kind === 'array') {
      const item = current.items[index];
      if (item === undefined) {
        return `${out}[?]`;
      }
      out += `[${index}]`;
      current = item;
      continue;
    }

    return `${out}/?`;
  }

  return out === '' ? '(raiz)' : out;
}

export function displayPathIn(document: JsonDocument, path: EditPath): string {
  return displayPath(document.root, path);
}

/**
 * Segmentos textuais do caminho, sem separador nenhum.
 *
 * Chave de objeto entra como está; índice de lista entra como o número. É a
 * forma canônica para exibir e para casar busca.
 */
export function pathSegments(root: JsonNode, path: EditPath): string[] {
  let current: JsonNode = root;
  const segments: string[] = [];

  for (const index of path) {
    if (current.kind === 'object') {
      const entry = current.entries[index];
      if (entry === undefined) {
        return segments;
      }
      segments.push(entry.key);
      current = entry.value;
      continue;
    }

    if (current.kind === 'array') {
      const item = current.items[index];
      if (item === undefined) {
        return segments;
      }
      segments.push(String(index));
      current = item;
      continue;
    }

    return segments;
  }

  return segments;
}

/**
 * Caminho na forma com pontos: `db_connections.banking.database`.
 *
 * É a notação da árvore e do breadcrumb. O diff e as mensagens de validação
 * seguem usando `displayPath`, com barra e colchete — as duas convivem de
 * propósito, e a busca aceita ambas para que um caminho copiado de uma mensagem
 * de validação encontre resultado. Ver `normalizePathQuery`.
 */
export function dottedPath(root: JsonNode, path: EditPath): string {
  const segments = pathSegments(root, path);

  return segments.length === 0 ? '' : segments.join('.');
}

/**
 * Quebra um caminho escrito à mão em segmentos comparáveis.
 *
 * Ponto, barra e colchete são tratados como **o mesmo separador**. Isso é o que
 * faz `/DATABASE/pool/min`, `DATABASE.pool.min` e `DATABASE/pool[0]` chegarem à
 * mesma lista — e é o que permite colar um caminho vindo de uma mensagem de
 * validação, que usa a outra notação, direto no campo de busca.
 *
 * Devolve em minúsculas: a comparação não diferencia caixa.
 */
export function normalizePathQuery(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[./[\]]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');
}
