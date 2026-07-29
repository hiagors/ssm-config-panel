import type {
  ContainerLayout,
  JsonDocument,
  JsonNode,
  ObjectEntry,
  SourceSpan,
} from './JsonDocument.js';
import { DEFAULT_DOCUMENT_STYLE, nextNodeId } from './JsonDocument.js';

/**
 * Parser de descida recursiva para JSON, com spans.
 *
 * Existe em vez de `JSON.parse` por três razões, todas exigidas pelo spec:
 * preservar o lexema do número, preservar ordem e duplicata de chave, e
 * guardar o span de cada nó para reemitir verbatim o que não foi editado.
 *
 * Aceita exatamente a gramática do JSON (RFC 8259) — sem comentário, sem
 * vírgula sobrando, sem chave sem aspas. O spec é explícito: não "consertar"
 * sozinho.
 *
 * A mensagem de erro carrega **apenas posição**, nunca trecho do conteúdo. A
 * mensagem nativa do `JSON.parse` embute parte da entrada, e a entrada pode
 * ser um `SecureString` decriptado.
 */

export interface ParseSuccess {
  readonly ok: true;
  readonly document: JsonDocument;
}

export interface ParseFailure {
  readonly ok: false;
  readonly error: JsonParseError;
}

export type ParseResult = ParseSuccess | ParseFailure;

export interface JsonParseError {
  readonly code: JsonParseErrorCode;
  /** 1-indexado, para casar com o que o editor mostra. */
  readonly line: number;
  readonly column: number;
  readonly offset: number;
  /** Texto acionável, sem nenhum trecho do conteúdo. */
  readonly message: string;
}

export type JsonParseErrorCode =
  | 'EMPTY_INPUT'
  | 'UNEXPECTED_CHARACTER'
  | 'UNEXPECTED_END'
  | 'TRAILING_CONTENT'
  | 'INVALID_NUMBER'
  | 'INVALID_STRING'
  | 'INVALID_ESCAPE'
  | 'INVALID_LITERAL'
  | 'MISSING_COLON'
  | 'TRAILING_COMMA'
  | 'EXPECTED_KEY';

class ParseAbort extends Error {
  constructor(readonly detail: { code: JsonParseErrorCode; offset: number; message: string }) {
    super(detail.code);
  }
}

export function parseJsonDocument(source: string): ParseResult {
  const parser = new Parser(source);

  try {
    return { ok: true, document: parser.parseDocument() };
  } catch (error) {
    if (error instanceof ParseAbort) {
      return { ok: false, error: toParseError(source, error.detail) };
    }
    throw error;
  }
}

function toParseError(
  source: string,
  detail: { code: JsonParseErrorCode; offset: number; message: string },
): JsonParseError {
  const clamped = Math.max(0, Math.min(detail.offset, source.length));
  const before = source.slice(0, clamped);
  const line = (before.match(/\n/g)?.length ?? 0) + 1;
  const lastNewline = before.lastIndexOf('\n');
  const column = clamped - lastNewline;

  return {
    code: detail.code,
    line,
    column,
    offset: clamped,
    message: `${detail.message} (linha ${line}, coluna ${column})`,
  };
}

const WHITESPACE = new Set([' ', '\t', '\n', '\r']);

class Parser {
  private position = 0;
  /**
   * Estilo detectado: a primeira ocorrência de cada coisa vence.
   *
   * O objetivo não é reproduzir o documento inteiro, e sim que um nó criado
   * na edição pareça pertencer ao arquivo em que foi inserido.
   */
  private detectedIndentUnit: string | undefined;
  private detectedKeySeparator: string | undefined;
  private detectedInlineSeparator: string | undefined;

  constructor(private readonly source: string) {}

  parseDocument(): JsonDocument {
    this.skipWhitespace();

    if (this.position >= this.source.length) {
      this.abort('EMPTY_INPUT', 'o valor está vazio', this.position);
    }

    const root = this.parseValue(0);

    this.skipWhitespace();

    if (this.position < this.source.length) {
      this.abort(
        'TRAILING_CONTENT',
        'há conteúdo depois do fim do JSON',
        this.position,
      );
    }

    return {
      source: this.source,
      root,
      style: {
        indentUnit: this.detectedIndentUnit ?? DEFAULT_DOCUMENT_STYLE.indentUnit,
        keySeparator: this.detectedKeySeparator ?? DEFAULT_DOCUMENT_STYLE.keySeparator,
        inlineSeparator: this.detectedInlineSeparator ?? this.fallbackInlineSeparator(),
      },
    };
  }

  /**
   * Separador entre itens quando o documento nunca mostrou um — caso de
   * objeto ou lista com um único elemento.
   *
   * Documento sem quebra de linha é minificado, e inserir um item nele deve
   * produzir `,` e não `, `: um espaço a mais por campo é ruído no diff e
   * bytes a mais contra o limite do tier.
   */
  private fallbackInlineSeparator(): string {
    return this.source.includes('\n') ? DEFAULT_DOCUMENT_STYLE.inlineSeparator : ',';
  }

  private parseValue(depth: number): JsonNode {
    const character = this.peek();

    switch (character) {
      case '{':
        return this.parseObject(depth);
      case '[':
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case 't':
      case 'f':
        return this.parseBoolean();
      case 'n':
        return this.parseNull();
      default:
        if (character === '-' || (character >= '0' && character <= '9')) {
          return this.parseNumber();
        }
        this.abort(
          'UNEXPECTED_CHARACTER',
          'caractere inesperado no início de um valor',
          this.position,
        );
    }
  }

  private parseObject(depth: number): JsonNode {
    const start = this.position;
    this.expect('{');

    const layout = this.captureOpenLayout();
    const entries: ObjectEntry[] = [];

    this.skipWhitespace();

    if (this.peek() === '}') {
      this.position += 1;
      return this.container('object', entries, [], start, undefined);
    }

    let inlineSeparator: string | undefined;
    let previousEnd = -1;

    for (;;) {
      this.skipWhitespace();

      if (this.peek() === '}') {
        this.abort('TRAILING_COMMA', 'JSON não aceita vírgula antes de "}"', this.position);
      }

      if (previousEnd !== -1 && inlineSeparator === undefined) {
        // Texto entre o fim da entrada anterior e o início desta: a vírgula
        // mais o espaço em branco de cada lado.
        inlineSeparator = this.source.slice(previousEnd, this.position);
        this.detectedInlineSeparator ??= inlineSeparator;
      }

      if (this.peek() !== '"') {
        this.abort('EXPECTED_KEY', 'era esperada uma chave entre aspas', this.position);
      }

      const entryStart = this.position;
      const keyNode = this.parseString();
      const keyEnd = this.position;

      this.skipWhitespace();

      if (this.peek() !== ':') {
        this.abort('MISSING_COLON', 'era esperado ":" depois da chave', this.position);
      }
      this.position += 1;

      this.skipWhitespace();
      // Tudo entre o fim da chave e o começo do valor: `:` mais o espaço em
      // branco que houver dos dois lados dele.
      const separator = this.source.slice(keyEnd, this.position);
      this.detectedKeySeparator ??= separator;

      const value = this.parseValue(depth + 1);
      const key = keyNode.kind === 'string' ? keyNode.value : '';

      entries.push({
        id: nextNodeId(),
        key,
        value,
        span: { start: entryStart, end: this.position },
        dirty: false,
        keySpan: { start: entryStart, end: keyEnd },
        originalKey: key,
        separator,
      });

      previousEnd = this.position;
      this.skipWhitespace();

      const next = this.peek();

      if (next === ',') {
        this.position += 1;
        continue;
      }
      if (next === '}') {
        break;
      }
      this.abort('UNEXPECTED_CHARACTER', 'era esperado "," ou "}"', this.position);
    }

    const closeIndent = this.captureCloseIndent();
    this.expect('}');

    return this.container(
      'object',
      entries,
      [],
      start,
      this.finishLayout(layout, closeIndent, inlineSeparator),
    );
  }

  private parseArray(depth: number): JsonNode {
    const start = this.position;
    this.expect('[');

    const layout = this.captureOpenLayout();
    const items: JsonNode[] = [];

    this.skipWhitespace();

    if (this.peek() === ']') {
      this.position += 1;
      return this.container('array', [], items, start, undefined);
    }

    let inlineSeparator: string | undefined;
    let previousEnd = -1;

    for (;;) {
      this.skipWhitespace();

      if (this.peek() === ']') {
        this.abort('TRAILING_COMMA', 'JSON não aceita vírgula antes de "]"', this.position);
      }

      if (previousEnd !== -1 && inlineSeparator === undefined) {
        inlineSeparator = this.source.slice(previousEnd, this.position);
        this.detectedInlineSeparator ??= inlineSeparator;
      }

      items.push(this.parseValue(depth + 1));

      previousEnd = this.position;
      this.skipWhitespace();

      const next = this.peek();

      if (next === ',') {
        this.position += 1;
        continue;
      }
      if (next === ']') {
        break;
      }
      this.abort('UNEXPECTED_CHARACTER', 'era esperado "," ou "]"', this.position);
    }

    const closeIndent = this.captureCloseIndent();
    this.expect(']');

    return this.container(
      'array',
      [],
      items,
      start,
      this.finishLayout(layout, closeIndent, inlineSeparator),
    );
  }

  private container(
    kind: 'object' | 'array',
    entries: ObjectEntry[],
    items: JsonNode[],
    start: number,
    layout: ContainerLayout | undefined,
  ): JsonNode {
    const span: SourceSpan = { start, end: this.position };
    const base = { id: nextNodeId(), span, dirty: false } as const;

    return kind === 'object'
      ? { ...base, kind: 'object', entries, layout }
      : { ...base, kind: 'array', items, layout };
  }

  /**
   * Lê o espaço em branco depois de `{`/`[` para descobrir se o container é
   * multilinha e qual a indentação dos itens.
   */
  private captureOpenLayout(): { multiline: boolean; itemIndent: string } {
    const start = this.position;
    let scan = this.position;

    while (scan < this.source.length && WHITESPACE.has(this.source[scan] as string)) {
      scan += 1;
    }

    const whitespace = this.source.slice(start, scan);
    const lastNewline = whitespace.lastIndexOf('\n');

    if (lastNewline === -1) {
      return { multiline: false, itemIndent: '' };
    }

    const itemIndent = whitespace.slice(lastNewline + 1);

    if (this.detectedIndentUnit === undefined && itemIndent !== '') {
      this.detectedIndentUnit = itemIndent;
    }

    return { multiline: true, itemIndent };
  }

  /** Indentação que precede a chave de fechamento. */
  private captureCloseIndent(): string {
    const whitespaceStart = this.position;
    let scan = this.position;

    while (scan < this.source.length && WHITESPACE.has(this.source[scan] as string)) {
      scan += 1;
    }

    const whitespace = this.source.slice(whitespaceStart, scan);
    const lastNewline = whitespace.lastIndexOf('\n');

    return lastNewline === -1 ? '' : whitespace.slice(lastNewline + 1);
  }

  private finishLayout(
    open: { multiline: boolean; itemIndent: string },
    closeIndent: string,
    inlineSeparator: string | undefined,
  ): ContainerLayout {
    return {
      multiline: open.multiline,
      itemIndent: open.itemIndent,
      closeIndent,
      // Container de um único item nunca revelou o separador; usa o do
      // documento, detectado em outro container.
      inlineSeparator:
        inlineSeparator ?? this.detectedInlineSeparator ?? this.fallbackInlineSeparator(),
    };
  }

  private parseString(): JsonNode {
    const start = this.position;
    this.expect('"');

    let value = '';

    for (;;) {
      if (this.position >= this.source.length) {
        this.abort('INVALID_STRING', 'a string não foi fechada', this.position);
      }

      const character = this.source[this.position] as string;

      if (character === '"') {
        this.position += 1;
        break;
      }

      if (character === '\\') {
        value += this.readEscape();
        continue;
      }

      // JSON proíbe caractere de controle cru dentro de string.
      if (character < ' ') {
        this.abort(
          'INVALID_STRING',
          'caractere de controle precisa ser escapado dentro da string',
          this.position,
        );
      }

      value += character;
      this.position += 1;
    }

    return {
      id: nextNodeId(),
      kind: 'string',
      value,
      span: { start, end: this.position },
      dirty: false,
    };
  }

  private readEscape(): string {
    // Posicionado na barra invertida.
    this.position += 1;

    if (this.position >= this.source.length) {
      this.abort('INVALID_ESCAPE', 'escape incompleto no fim da string', this.position);
    }

    const character = this.source[this.position] as string;
    this.position += 1;

    switch (character) {
      case '"':
        return '"';
      case '\\':
        return '\\';
      case '/':
        return '/';
      case 'b':
        return '\b';
      case 'f':
        return '\f';
      case 'n':
        return '\n';
      case 'r':
        return '\r';
      case 't':
        return '\t';
      case 'u':
        return this.readUnicodeEscape();
      default:
        this.abort('INVALID_ESCAPE', 'sequência de escape desconhecida', this.position - 1);
    }
  }

  private readUnicodeEscape(): string {
    const hex = this.source.slice(this.position, this.position + 4);

    if (!/^[0-9a-fA-F]{4}$/.test(hex)) {
      this.abort('INVALID_ESCAPE', 'escape \\u exige quatro dígitos hexadecimais', this.position);
    }

    this.position += 4;
    // `parseInt` aqui é sobre um escape de 4 hexadecimais, não sobre um número
    // JSON: não há perda de precisão possível e nada disso alimenta o lexema
    // numérico do documento.
    return String.fromCharCode(Number.parseInt(hex, 16));
  }

  /**
   * Lê o número validando a gramática caractere a caractere.
   *
   * O resultado é o **lexema**, guardado como texto. Nada aqui converte para
   * `number`: `9007199254740993` e `30.0` precisam sobreviver.
   */
  private parseNumber(): JsonNode {
    const start = this.position;

    if (this.peek() === '-') {
      this.position += 1;
    }

    // Parte inteira: `0` sozinho, ou dígito de 1-9 seguido de dígitos.
    if (this.peek() === '0') {
      this.position += 1;
      if (this.isDigit(this.peekOrEmpty())) {
        this.abort('INVALID_NUMBER', 'JSON não aceita zero à esquerda', this.position);
      }
    } else if (this.isDigit(this.peekOrEmpty())) {
      while (this.isDigit(this.peekOrEmpty())) {
        this.position += 1;
      }
    } else {
      this.abort('INVALID_NUMBER', 'era esperado um dígito', this.position);
    }

    // Parte fracionária.
    if (this.peekOrEmpty() === '.') {
      this.position += 1;
      if (!this.isDigit(this.peekOrEmpty())) {
        this.abort(
          'INVALID_NUMBER',
          'era esperado ao menos um dígito depois do ponto decimal',
          this.position,
        );
      }
      while (this.isDigit(this.peekOrEmpty())) {
        this.position += 1;
      }
    }

    // Expoente.
    const exponent = this.peekOrEmpty();
    if (exponent === 'e' || exponent === 'E') {
      this.position += 1;
      const sign = this.peekOrEmpty();
      if (sign === '+' || sign === '-') {
        this.position += 1;
      }
      if (!this.isDigit(this.peekOrEmpty())) {
        this.abort('INVALID_NUMBER', 'o expoente está incompleto', this.position);
      }
      while (this.isDigit(this.peekOrEmpty())) {
        this.position += 1;
      }
    }

    return {
      id: nextNodeId(),
      kind: 'number',
      raw: this.source.slice(start, this.position),
      span: { start, end: this.position },
      dirty: false,
    };
  }

  private parseBoolean(): JsonNode {
    const start = this.position;

    if (this.source.startsWith('true', start)) {
      this.position += 4;
      return this.literal('boolean', true, start);
    }
    if (this.source.startsWith('false', start)) {
      this.position += 5;
      return this.literal('boolean', false, start);
    }

    this.abort('INVALID_LITERAL', 'literal inválido; era esperado true ou false', start);
  }

  private parseNull(): JsonNode {
    const start = this.position;

    if (!this.source.startsWith('null', start)) {
      this.abort('INVALID_LITERAL', 'literal inválido; era esperado null', start);
    }

    this.position += 4;

    return {
      id: nextNodeId(),
      kind: 'null',
      span: { start, end: this.position },
      dirty: false,
    };
  }

  private literal(kind: 'boolean', value: boolean, start: number): JsonNode {
    return {
      id: nextNodeId(),
      kind,
      value,
      span: { start, end: this.position },
      dirty: false,
    };
  }

  private isDigit(character: string): boolean {
    return character >= '0' && character <= '9';
  }

  private peek(): string {
    if (this.position >= this.source.length) {
      this.abort('UNEXPECTED_END', 'o JSON termina antes do esperado', this.position);
    }
    return this.source[this.position] as string;
  }

  /** Como `peek`, mas devolve string vazia no fim em vez de abortar. */
  private peekOrEmpty(): string {
    return this.position >= this.source.length ? '' : (this.source[this.position] as string);
  }

  private expect(character: string): void {
    if (this.peek() !== character) {
      this.abort('UNEXPECTED_CHARACTER', `era esperado "${character}"`, this.position);
    }
    this.position += 1;
  }

  private skipWhitespace(): void {
    while (
      this.position < this.source.length &&
      WHITESPACE.has(this.source[this.position] as string)
    ) {
      this.position += 1;
    }
  }

  private abort(code: JsonParseErrorCode, message: string, offset: number): never {
    throw new ParseAbort({ code, offset, message });
  }
}
