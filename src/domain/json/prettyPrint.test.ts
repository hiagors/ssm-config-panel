import { describe, expect, it } from 'vitest';
import type { JsonDocument } from './JsonDocument.js';
import { parseJsonDocument } from './parseJsonDocument.js';
import { serializeJsonDocument } from './serializeJsonDocument.js';
import { structuralDiff } from './structuralDiff.js';
import { prettyPrintDocument, wouldChangeAppearance } from './prettyPrint.js';
import { setNumberLexeme } from './editOperations.js';

/**
 * Pretty-print é visualização, e o teste central é negativo: **ligar o toggle e
 * salvar não pode produzir mudança alguma**.
 *
 * Formatar o documento de verdade marcaria todo nó como `dirty`, destruiria a
 * reemissão verbatim, encheria o diff e faria um save sem edição reescrever o
 * parâmetro inteiro. Como a formatação só existe no render, nada disso acontece
 * — e é isso que estes testes fixam.
 */

function parse(source: string): JsonDocument {
  const result = parseJsonDocument(source);
  if (!result.ok) {
    throw new Error(`parse falhou: ${result.error.code}`);
  }
  return result.document;
}

/** O caso real: parâmetro minificado em linha única. */
const MINIFIED = '{"SERVICE":"api","PORT":8080,"DB":{"host":"localhost","pool":{"min":1,"max":10}},"TAGS":["a","b"]}';

describe('formatar não altera o documento', () => {
  it('ligar o toggle e salvar não produz mudança', () => {
    // O teste que o spec exige.
    const document = parse(MINIFIED);

    const formatted = prettyPrintDocument(document);
    const whatWouldBeSaved = serializeJsonDocument(document);

    expect(formatted).not.toBe(whatWouldBeSaved);
    expect(whatWouldBeSaved).toBe(MINIFIED);
  });

  it('o diff continua vazio depois de formatar', () => {
    const document = parse(MINIFIED);

    prettyPrintDocument(document);

    expect(structuralDiff(document, document).isEmpty).toBe(true);
  });

  it('nenhum nó fica sujo', () => {
    const document = parse(MINIFIED);

    prettyPrintDocument(document);

    expect(document.root.dirty).toBe(false);
    expect(document.root.kind === 'object' && document.root.entries.every((e) => !e.dirty)).toBe(
      true,
    );
  });

  it('o texto de origem não é tocado', () => {
    const document = parse(MINIFIED);

    prettyPrintDocument(document);

    expect(document.source).toBe(MINIFIED);
  });

  it('formatar duas vezes dá o mesmo resultado', () => {
    const document = parse(MINIFIED);

    expect(prettyPrintDocument(document)).toBe(prettyPrintDocument(document));
  });
});

describe('o que a formatação produz', () => {
  it('indenta com dois espaços e uma chave por linha', () => {
    expect(prettyPrintDocument(parse('{"a":1,"b":2}'))).toBe('{\n  "a": 1,\n  "b": 2\n}');
  });

  it('aninha corretamente', () => {
    expect(prettyPrintDocument(parse('{"a":{"b":{"c":1}}}'))).toBe(
      '{\n  "a": {\n    "b": {\n      "c": 1\n    }\n  }\n}',
    );
  });

  it('formata lista com um item por linha', () => {
    expect(prettyPrintDocument(parse('{"a":[1,2]}'))).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
  });

  it('container vazio fica em linha única', () => {
    expect(prettyPrintDocument(parse('{"a":{},"b":[]}'))).toBe('{\n  "a": {},\n  "b": []\n}');
  });

  it('escalar na raiz não ganha quebra', () => {
    expect(prettyPrintDocument(parse('42'))).toBe('42');
    expect(prettyPrintDocument(parse('"texto"'))).toBe('"texto"');
  });
});

describe('o lexema do número sobrevive à formatação', () => {
  it.each([
    ['{"a":30.0}', '30.0'],
    ['{"a":9007199254740993}', '9007199254740993'],
    ['{"a":1.50}', '1.50'],
    ['{"a":1e5}', '1e5'],
    ['{"a":-0}', '-0'],
  ])('%s preserva %s', (source, lexeme) => {
    // Reparsear na visualização reintroduziria a perda de precisão que o modelo
    // inteiro existe para evitar.
    expect(prettyPrintDocument(parse(source))).toContain(lexeme);
  });

  it('lexema inválido é exibido como está, sem mascarar o erro', () => {
    const document = setNumberLexeme(parse('{"a":1}'), [0], 'abc');

    expect(prettyPrintDocument(document)).toContain('abc');
  });
});

describe('null e string vazia continuam distintos', () => {
  it('formata os dois de forma diferente', () => {
    expect(prettyPrintDocument(parse('{"a":null,"b":""}'))).toBe('{\n  "a": null,\n  "b": ""\n}');
  });
});

describe('wouldChangeAppearance', () => {
  it('true quando o documento está minificado', () => {
    const document = parse(MINIFIED);

    expect(wouldChangeAppearance(document, serializeJsonDocument(document))).toBe(true);
  });

  it('false quando já está no formato que o pretty-print produziria', () => {
    // Toggle que não muda nada na tela é ruído.
    const source = '{\n  "a": 1\n}';
    const document = parse(source);

    expect(wouldChangeAppearance(document, source)).toBe(false);
  });
});

describe('caracteres especiais', () => {
  it('escapes são reemitidos corretamente', () => {
    const document = parse('{"a":"linha\\nquebra"}');

    expect(prettyPrintDocument(document)).toBe('{\n  "a": "linha\\nquebra"\n}');
  });

  it('acento não é escapado', () => {
    expect(prettyPrintDocument(parse('{"a":"ção"}'))).toContain('ção');
  });

  it('chave duplicada aparece duas vezes, como no documento', () => {
    expect(prettyPrintDocument(parse('{"a":1,"a":2}'))).toBe('{\n  "a": 1,\n  "a": 2\n}');
  });
});
