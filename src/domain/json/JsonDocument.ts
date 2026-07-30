/**
 * Modelo de documento do editor.
 *
 * Não é o resultado de `JSON.parse`. Três coisas que o `JSON.parse` perde e
 * que o spec exige preservar:
 *
 *   JSON.parse('{"timeout": 30.0}')   -> {timeout: 30}      perde int vs float
 *   JSON.parse('{"2":"b","1":"a"}')   -> chaves reordenadas  objeto JS ordena
 *                                                            chave numérica
 *   JSON.parse('{"a":1,"a":2}')       -> {a: 2}             perde a duplicata
 *
 * Por isso: número guarda o **lexema**, objeto guarda **lista ordenada** de
 * entradas (e aceita duplicata, para a validação poder acusar), e cada nó
 * guarda seu **span** no texto de origem.
 *
 * O span é o que faz "não reformatar o que não foi tocado" ser literal:
 * subárvore com `dirty === false` é reemitida byte a byte a partir de
 * `JsonDocument.source`.
 */

import { DEFAULT_NUMBER_LEXEME } from './jsonNumber.js';

/** Intervalo `[start, end)` no texto de origem. */
export interface SourceSpan {
  readonly start: number;
  readonly end: number;
}

export type JsonNodeKind = 'string' | 'number' | 'boolean' | 'null' | 'object' | 'array';

/**
 * Tipos que o seletor da linha oferece.
 *
 * Só escalares. Converter para `object` ou `array` saiu do seletor e virou ação
 * de menu, com confirmação quando há conteúdo a perder: escolher "objeto" num
 * `<select>` descartava o valor em silêncio, e um clique errado num select é
 * fácil demais para uma ação destrutiva.
 */
export const SCALAR_KINDS: readonly JsonNodeKind[] = ['string', 'number', 'boolean', 'null'];

interface NodeBase {
  /** Identidade estável para key do React e para reordenar sem remontar. */
  readonly id: string;
  /** Span no texto de origem. `undefined` em nó criado durante a edição. */
  readonly span: SourceSpan | undefined;
  /**
   * `true` quando este nó ou algum descendente foi editado.
   *
   * Nó limpo com span é emitido verbatim. Nó sujo é reemitido, e seus filhos
   * limpos continuam saindo verbatim.
   */
  readonly dirty: boolean;
}

export interface JsonStringNode extends NodeBase {
  readonly kind: 'string';
  /** Valor já decodificado (`\n` virou quebra de linha de verdade). */
  readonly value: string;
}

export interface JsonNumberNode extends NodeBase {
  readonly kind: 'number';
  /** Lexema exatamente como no texto. Nunca convertido para `number`. */
  readonly raw: string;
}

export interface JsonBooleanNode extends NodeBase {
  readonly kind: 'boolean';
  readonly value: boolean;
}

export interface JsonNullNode extends NodeBase {
  readonly kind: 'null';
}

/**
 * Layout capturado do texto de origem, para reemitir um container editado
 * com a mesma cara que ele tinha.
 */
export interface ContainerLayout {
  readonly multiline: boolean;
  /** Indentação de cada item. */
  readonly itemIndent: string;
  /** Indentação da chave de fechamento. */
  readonly closeIndent: string;
  /** Texto entre itens quando o container é de uma linha. Ex.: `,` ou `, `. */
  readonly inlineSeparator: string;
}

/**
 * Estilo detectado do documento, para nós criados durante a edição.
 *
 * Sem isto, inserir um campo num parâmetro minificado devolveria
 * `{"a":1, "b": 0}` — com espaços que não existiam em nenhum outro lugar do
 * arquivo. O estilo é copiado do que o documento já usava.
 */
export interface DocumentStyle {
  /** Unidade de indentação. Ex.: dois espaços, ou tab. */
  readonly indentUnit: string;
  /** Texto entre chave e valor. Ex.: `": "` ou `":"`. */
  readonly keySeparator: string;
  /** Texto entre itens de container de uma linha. Ex.: `", "` ou `","`. */
  readonly inlineSeparator: string;
}

export const DEFAULT_DOCUMENT_STYLE: DocumentStyle = Object.freeze({
  indentUnit: '  ',
  keySeparator: ': ',
  inlineSeparator: ', ',
});

export interface JsonObjectNode extends NodeBase {
  readonly kind: 'object';
  readonly entries: readonly ObjectEntry[];
  readonly layout: ContainerLayout | undefined;
}

export interface JsonArrayNode extends NodeBase {
  readonly kind: 'array';
  readonly items: readonly JsonNode[];
  readonly layout: ContainerLayout | undefined;
}

export type JsonNode =
  | JsonStringNode
  | JsonNumberNode
  | JsonBooleanNode
  | JsonNullNode
  | JsonObjectNode
  | JsonArrayNode;

export type JsonContainerNode = JsonObjectNode | JsonArrayNode;

/**
 * Uma entrada de objeto.
 *
 * `span` cobre `"chave": valor` — do primeiro caractere do token da chave ao
 * último do valor, sem a vírgula. Entrada limpa sai verbatim por esse span.
 *
 * Os três campos seguintes existem para o caso mais comum da edição: mudar só
 * o valor. Aí a entrada está suja, mas a chave e o separador continuam sendo
 * os originais e devem sair como estavam. Sem isso, editar um valor num JSON
 * minificado transformaria `"a":1` em `"a": 1` — um espaço que ninguém pediu,
 * num parâmetro que é uma linha só.
 */
export interface ObjectEntry {
  readonly id: string;
  /** Chave já decodificada, como está agora (pode ter sido renomeada). */
  readonly key: string;
  readonly value: JsonNode;
  readonly span: SourceSpan | undefined;
  readonly dirty: boolean;
  /** Span do token da chave no original, com as aspas. */
  readonly keySpan: SourceSpan | undefined;
  /** Chave como veio do parse, para detectar se houve rename. */
  readonly originalKey: string | undefined;
  /** Texto entre o fim do token da chave e o início do valor. Ex.: `": "`. */
  readonly separator: string | undefined;
}

/**
 * Documento completo.
 *
 * `source` é o texto do qual este documento foi parseado, e é imutável: as
 * operações de edição devolvem documento novo com o mesmo `source` e uma
 * `root` diferente. Serializar um documento sem edição alguma devolve
 * `source` byte a byte.
 *
 * ATENÇÃO: `source` **não** é a base do diff. A base do diff é o snapshot do
 * texto carregado do store, guardado separadamente em `DraftState.base`.
 * Quando o usuário edita a aba JSON cru, o documento é reparseado e passa a
 * ter um `source` novo — que já não é o que veio do store. Confundir os dois
 * faria a base derivar do estado atual e o diff subestimar as mudanças.
 */
export interface JsonDocument {
  readonly source: string;
  readonly root: JsonNode;
  /** Estilo detectado do original, para nós criados na edição. */
  readonly style: DocumentStyle;
}

// ─── criação de nós ──────────────────────────────────────────────────────────

let idCounter = 0;

/** Identidade nova. Só unicidade dentro do processo é necessária. */
export function nextNodeId(): string {
  idCounter += 1;
  return `n${idCounter}`;
}

/** Só para teste: reinicia o contador, para ids previsíveis. */
export function resetNodeIds(): void {
  idCounter = 0;
}

/** Nó novo, criado na edição: sem span, já sujo. */
export function createNode(kind: JsonNodeKind): JsonNode {
  const base = { id: nextNodeId(), span: undefined, dirty: true } as const;

  switch (kind) {
    case 'string':
      return { ...base, kind: 'string', value: '' };
    case 'number':
      return { ...base, kind: 'number', raw: DEFAULT_NUMBER_LEXEME };
    case 'boolean':
      return { ...base, kind: 'boolean', value: false };
    case 'null':
      return { ...base, kind: 'null' };
    case 'object':
      return { ...base, kind: 'object', entries: [], layout: undefined };
    case 'array':
      return { ...base, kind: 'array', items: [], layout: undefined };
  }
}

export function createEntry(key: string, value: JsonNode): ObjectEntry {
  return {
    id: nextNodeId(),
    key,
    value,
    span: undefined,
    dirty: true,
    keySpan: undefined,
    originalKey: undefined,
    separator: undefined,
  };
}

// ─── consultas ───────────────────────────────────────────────────────────────

export function isContainer(node: JsonNode): node is JsonContainerNode {
  return node.kind === 'object' || node.kind === 'array';
}

/** Rótulo em português para o seletor de tipo. */
export function kindLabel(kind: JsonNodeKind): string {
  switch (kind) {
    case 'string':
      return 'texto';
    case 'number':
      return 'número';
    case 'boolean':
      return 'booleano';
    case 'object':
      return 'objeto';
    case 'array':
      return 'lista';
    case 'null':
      return 'null';
  }
}

/**
 * Texto bruto de um escalar, ou `undefined` quando o nó não guarda texto.
 *
 * `string` e `number` guardam texto; `boolean` e `null` não — o modelo não tem
 * onde pôr um booleano inválido. É essa assimetria que decide o que sobrevive a
 * uma troca de tipo: ver `changeNodeKind`.
 */
export function scalarText(node: JsonNode): string | undefined {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'number':
      return node.raw;
    default:
      return undefined;
  }
}

/**
 * `true` quando trocar o tipo deste nó destrói conteúdo de verdade.
 *
 * É o gatilho da confirmação. Campo vazio, `null` e container vazio **não**
 * abrem diálogo: não há nada a perder, e pedir confirmação para uma operação
 * inócua ensina o usuário a clicar em "confirmar" sem ler.
 */
export function hasContentToLose(node: JsonNode): boolean {
  switch (node.kind) {
    case 'string':
      return node.value !== '';
    case 'number':
      return node.raw !== '';
    case 'boolean':
      // Um booleano é informação, mas cabe em qualquer conversão para texto e
      // não sobrevive a nada mais. Ver a tabela em `changeNodeKind`.
      return false;
    case 'null':
      return false;
    case 'object':
      return node.entries.length > 0;
    case 'array':
      return node.items.length > 0;
  }
}

/** Contagem de filhos, para o resumo do painel aninhado. */
export function childCount(node: JsonNode): number {
  if (node.kind === 'object') {
    return node.entries.length;
  }
  if (node.kind === 'array') {
    return node.items.length;
  }
  return 0;
}
