import type {
  ContainerLayout,
  JsonDocument,
  JsonNode,
  ObjectEntry,
} from './JsonDocument.js';

/**
 * Serializa o documento preservando o que não foi editado.
 *
 * A regra é uma só: **nó limpo com span sai verbatim** do texto de origem.
 * Consequências, que são exatamente o que o spec pede:
 *
 * - Documento sem edição alguma serializa byte a byte igual ao original,
 *   então o diff de um round-trip é vazio.
 * - Editar um campo não reformata os vizinhos: `{ "x":1,   "y":2 }` mantém o
 *   espaçamento torto se ninguém mexeu nele.
 * - `30.0` continua `30.0`, porque o lexema nunca virou `number`.
 *
 * O que **é** reformatado: um container editado reemite os separadores entre
 * seus itens (vírgula, quebra de linha, indentação), usando o layout que ele
 * tinha no original. Os itens em si continuam verbatim. Isso é necessário
 * porque inserir ou remover item muda quantos separadores existem.
 */

export function serializeJsonDocument(document: JsonDocument): string {
  return serializeNode(document.root, document, 0);
}

function serializeNode(node: JsonNode, document: JsonDocument, depth: number): string {
  if (!node.dirty && node.span !== undefined) {
    return document.source.slice(node.span.start, node.span.end);
  }

  switch (node.kind) {
    case 'string':
      return encodeJsonString(node.value);
    case 'number':
      // Lexema, sempre. Nunca passou por Number().
      return node.raw;
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
      return 'null';
    case 'object':
      return serializeObject(node.entries, node.layout, document, depth);
    case 'array':
      return serializeArray(node.items, node.layout, document, depth);
  }
}

function serializeObject(
  entries: readonly ObjectEntry[],
  layout: ContainerLayout | undefined,
  document: JsonDocument,
  depth: number,
): string {
  if (entries.length === 0) {
    return '{}';
  }

  const resolved = resolveLayout(layout, document, depth);
  const parts = entries.map((entry) => serializeEntry(entry, document, depth + 1));

  return wrap('{', '}', parts, resolved);
}

function serializeArray(
  items: readonly JsonNode[],
  layout: ContainerLayout | undefined,
  document: JsonDocument,
  depth: number,
): string {
  if (items.length === 0) {
    return '[]';
  }

  const resolved = resolveLayout(layout, document, depth);
  const parts = items.map((item) => serializeNode(item, document, depth + 1));

  return wrap('[', ']', parts, resolved);
}

function serializeEntry(entry: ObjectEntry, document: JsonDocument, depth: number): string {
  if (!entry.dirty && entry.span !== undefined) {
    return document.source.slice(entry.span.start, entry.span.end);
  }

  const value = serializeNode(entry.value, document, depth);

  // Caso mais comum da edição: mudou só o valor. Chave e separador continuam
  // sendo os do original e saem verbatim, então editar `"a":1` num JSON
  // minificado produz `"a":2`, e não `"a": 2`.
  if (
    entry.keySpan !== undefined &&
    entry.separator !== undefined &&
    entry.originalKey === entry.key
  ) {
    const keyText = document.source.slice(entry.keySpan.start, entry.keySpan.end);
    return `${keyText}${entry.separator}${value}`;
  }

  // Chave renomeada ou entrada criada agora: usa o separador que a entrada
  // tinha, se tinha, senão o estilo detectado no documento.
  return `${encodeJsonString(entry.key)}${entry.separator ?? document.style.keySeparator}${value}`;
}

function wrap(
  open: string,
  close: string,
  parts: readonly string[],
  layout: ContainerLayout,
): string {
  if (!layout.multiline) {
    // Usa o separador que o container tinha: num JSON minificado é `,`, e
    // normalizar para `, ` inflaria o payload e sujaria o diff.
    return `${open}${parts.join(layout.inlineSeparator)}${close}`;
  }

  const body = parts.map((part) => `${layout.itemIndent}${part}`).join(',\n');

  return `${open}\n${body}\n${layout.closeIndent}${close}`;
}

/**
 * Layout de um container criado durante a edição, que não tem original.
 *
 * Herda o estilo do documento: multilinha com a unidade de indentação
 * detectada, repetida conforme a profundidade. Um container que veio do
 * original usa o layout dele.
 */
function resolveLayout(
  layout: ContainerLayout | undefined,
  document: JsonDocument,
  depth: number,
): ContainerLayout {
  if (layout !== undefined) {
    return layout;
  }

  const { indentUnit, inlineSeparator } = document.style;

  // Documento em linha única (o caso dos parâmetros minificados) não deve
  // ganhar quebra de linha só porque um objeto novo foi inserido.
  if (!document.source.includes('\n')) {
    return { multiline: false, itemIndent: '', closeIndent: '', inlineSeparator };
  }

  return {
    multiline: true,
    itemIndent: indentUnit.repeat(depth + 1),
    closeIndent: indentUnit.repeat(depth),
    inlineSeparator,
  };
}

/** Caracteres que o JSON exige escapar, e o escape curto de cada um. */
const SHORT_ESCAPES: Readonly<Record<string, string>> = Object.freeze({
  '"': '\\"',
  '\\': '\\\\',
  '\b': '\\b',
  '\f': '\\f',
  '\n': '\\n',
  '\r': '\\r',
  '\t': '\\t',
});

/**
 * Codifica uma string como literal JSON.
 *
 * Escapa o mínimo exigido pela RFC 8259: aspas, barra invertida e controles
 * abaixo de 0x20. Não escapa `/` nem caractere não-ASCII — JSON aceita UTF-8
 * cru, e escapar acento produziria ruído em todo diff.
 */
export function encodeJsonString(value: string): string {
  let out = '"';

  for (const character of value) {
    const short = SHORT_ESCAPES[character];

    if (short !== undefined) {
      out += short;
      continue;
    }

    if (character < ' ') {
      out += `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }

    out += character;
  }

  return `${out}"`;
}
