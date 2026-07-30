import type { JsonDocument, JsonNode, ObjectEntry } from './JsonDocument.js';
import { encodeJsonString } from './serializeJsonDocument.js';

/**
 * Pretty-print **como visualização**, nunca como edição.
 *
 * Os parâmetros reais são JSON minificado em linha única, e a aba de texto cru
 * fica ilegível assim. Mas formatar o documento de verdade seria desastre em
 * três frentes ao mesmo tempo:
 *
 * 1. Marcaria todo nó como `dirty`, destruindo a reemissão verbatim.
 * 2. Um save sem nenhuma edição reescreveria o parâmetro inteiro.
 * 3. O diff mostraria o documento todo alterado, escondendo a mudança real.
 *
 * Por isso esta função **não devolve documento**: devolve texto, e o texto some
 * quando o toggle é desligado. Nada aqui toca em `dirty`, span ou `source`. O
 * teste que fecha essa promessa está em `prettyPrint.test.ts`: ligar o toggle e
 * salvar não produz mudança alguma.
 *
 * O lexema do número é copiado como está — nunca reparseado. `30.0` continua
 * `30.0` também na visualização formatada.
 */

const INDENT = '  ';

/** Formata para leitura. O resultado é para a tela, não para gravar. */
export function prettyPrintDocument(document: JsonDocument): string {
  return printNode(document.root, 0);
}

function printNode(node: JsonNode, depth: number): string {
  switch (node.kind) {
    case 'string':
      return encodeJsonString(node.value);

    case 'number':
      // O lexema, sempre. Reparsear aqui reintroduziria a perda de precisão que
      // o modelo inteiro existe para evitar.
      return node.raw;

    case 'boolean':
      return node.value ? 'true' : 'false';

    case 'null':
      return 'null';

    case 'object':
      return printObject(node.entries, depth);

    case 'array':
      return printArray(node.items, depth);
  }
}

function printObject(entries: readonly ObjectEntry[], depth: number): string {
  if (entries.length === 0) {
    return '{}';
  }

  const inner = INDENT.repeat(depth + 1);
  const body = entries
    .map((entry) => `${inner}${encodeJsonString(entry.key)}: ${printNode(entry.value, depth + 1)}`)
    .join(',\n');

  return `{\n${body}\n${INDENT.repeat(depth)}}`;
}

function printArray(items: readonly JsonNode[], depth: number): string {
  if (items.length === 0) {
    return '[]';
  }

  const inner = INDENT.repeat(depth + 1);
  const body = items.map((item) => `${inner}${printNode(item, depth + 1)}`).join(',\n');

  return `[\n${body}\n${INDENT.repeat(depth)}]`;
}

/**
 * `true` quando formatar muda alguma coisa na tela.
 *
 * Documento já indentado não ganha nada com o toggle, e oferecer um botão que
 * não faz diferença visível é ruído.
 */
export function wouldChangeAppearance(document: JsonDocument, currentText: string): boolean {
  return prettyPrintDocument(document) !== currentText;
}
