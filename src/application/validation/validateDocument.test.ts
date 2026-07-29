import { describe, expect, it } from 'vitest';
import { parseJsonDocument } from '../../domain/json/parseJsonDocument.js';
import type { JsonDocument } from '../../domain/json/JsonDocument.js';
import { appendEntry, setNumberLexeme } from '../../domain/json/editOperations.js';
import { issuesByPath, validateDocument } from './validateDocument.js';

const SENTINEL = 'SENTINEL-validation-7b2e-DO-NOT-LEAK';

function parseOrThrow(source: string): JsonDocument {
  const result = parseJsonDocument(source);
  if (!result.ok) {
    throw new Error(`parse falhou: ${result.error.code}`);
  }
  return result.document;
}

describe('validateDocument — chaves', () => {
  it('documento correto não gera problema', () => {
    const result = validateDocument(parseOrThrow('{"a":1,"b":"x"}'), 'Standard');

    expect(result.issues).toEqual([]);
    expect(result.canSave).toBe(true);
  });

  it('acusa chave vazia', () => {
    const result = validateDocument(parseOrThrow('{"":1}'), 'Standard');

    expect(result.issues.map((issue) => issue.code)).toContain('EMPTY_KEY');
    expect(result.canSave).toBe(false);
  });

  it('acusa chave duplicada', () => {
    const result = validateDocument(parseOrThrow('{"a":1,"a":2}'), 'Standard');
    const duplicate = result.issues.find((issue) => issue.code === 'DUPLICATE_KEY');

    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toMatch(/posições 1 e 2/);
    expect(result.canSave).toBe(false);
  });

  it('não acusa duplicata em níveis diferentes', () => {
    const result = validateDocument(parseOrThrow('{"a":1,"b":{"a":2}}'), 'Standard');

    expect(result.issues).toEqual([]);
  });

  it('acusa duplicata dentro de objeto aninhado', () => {
    const result = validateDocument(parseOrThrow('{"o":{"a":1,"a":2}}'), 'Standard');

    expect(result.issues.map((issue) => issue.code)).toContain('DUPLICATE_KEY');
  });

  it('chave que difere só na caixa não é duplicata', () => {
    // JSON é case-sensitive; acusar aqui seria invenção nossa.
    const result = validateDocument(parseOrThrow('{"a":1,"A":2}'), 'Standard');

    expect(result.issues).toEqual([]);
  });

  it('duas chaves vazias acusam vazio, sem duplicar o de duplicata', () => {
    const result = validateDocument(parseOrThrow('{"":1,"":2}'), 'Standard');
    const codes = result.issues.map((issue) => issue.code);

    expect(codes.filter((code) => code === 'EMPTY_KEY')).toHaveLength(2);
    expect(codes).not.toContain('DUPLICATE_KEY');
  });
});

describe('validateDocument — números', () => {
  it('acusa lexema inválido', () => {
    const document = setNumberLexeme(parseOrThrow('{"a":1}'), [0], '1e');
    const result = validateDocument(document, 'Standard');

    expect(result.issues.map((issue) => issue.code)).toContain('INVALID_NUMBER');
    expect(result.canSave).toBe(false);
  });

  it('aceita inteiro acima de 2^53 sem reclamar', () => {
    const document = setNumberLexeme(parseOrThrow('{"a":1}'), [0], '9007199254740993');

    expect(validateDocument(document, 'Standard').issues).toEqual([]);
  });

  it('aceita float com zeros à direita', () => {
    const document = setNumberLexeme(parseOrThrow('{"a":1}'), [0], '30.0');

    expect(validateDocument(document, 'Standard').issues).toEqual([]);
  });

  it('acusa número inválido dentro de lista', () => {
    const document = setNumberLexeme(parseOrThrow('{"a":[1,2]}'), [0, 1], '-');
    const result = validateDocument(document, 'Standard');
    const issue = result.issues.find((candidate) => candidate.code === 'INVALID_NUMBER');

    expect(issue).toBeDefined();
    expect(issue?.label).toBe('/a[1]');
  });
});

describe('validateDocument — tamanho', () => {
  it('avisa a partir de 90% do limite do tier', () => {
    const filler = 'x'.repeat(Math.floor(4096 * 0.92));
    const result = validateDocument(parseOrThrow(`{"a":"${filler}"}`), 'Standard');

    expect(result.issues.map((issue) => issue.code)).toContain('SIZE_WARNING');
    // Aviso não bloqueia.
    expect(result.canSave).toBe(true);
  });

  it('erra quando estoura o limite do Standard', () => {
    const filler = 'x'.repeat(5000);
    const result = validateDocument(parseOrThrow(`{"a":"${filler}"}`), 'Standard');

    expect(result.issues.map((issue) => issue.code)).toContain('SIZE_EXCEEDED');
    expect(result.canSave).toBe(false);
  });

  it('o mesmo payload passa no tier Advanced', () => {
    const filler = 'x'.repeat(5000);
    const result = validateDocument(parseOrThrow(`{"a":"${filler}"}`), 'Advanced');

    expect(result.issues.map((issue) => issue.code)).not.toContain('SIZE_EXCEEDED');
    expect(result.sizeLimitInBytes).toBe(8192);
  });

  it('conta bytes UTF-8, não caracteres', () => {
    const result = validateDocument(parseOrThrow('{"a":"çãé"}'), 'Standard');

    // 3 caracteres acentuados = 6 bytes, mais {"a":""} = 8.
    expect(result.sizeInBytes).toBe(14);
  });

  it('mede o texto que seria gravado, incluindo edição', () => {
    const document = appendEntry(parseOrThrow('{"a":1}'), [], 'b', 'string');
    const result = validateDocument(document, 'Standard');

    expect(result.sizeInBytes).toBe('{"a":1,"b":""}'.length);
  });
});

describe('validateDocument — mensagens não vazam valor', () => {
  it('nenhuma mensagem contém o valor de um campo', () => {
    const source = `{"":"${SENTINEL}","dup":"${SENTINEL}","dup":"${SENTINEL}"}`;
    const result = validateDocument(parseOrThrow(source), 'Standard');

    expect(result.issues.length).toBeGreaterThan(0);
    expect(JSON.stringify(result.issues)).not.toContain(SENTINEL);
  });

  it('mensagem de número inválido não repassa o lexema', () => {
    const document = setNumberLexeme(parseOrThrow('{"a":1}'), [0], `${SENTINEL}`);
    const result = validateDocument(document, 'Standard');

    expect(JSON.stringify(result.issues)).not.toContain(SENTINEL);
  });

  it('mensagem de tamanho não repassa o conteúdo', () => {
    const filler = SENTINEL.repeat(300);
    const result = validateDocument(parseOrThrow(`{"a":"${filler}"}`), 'Standard');

    expect(JSON.stringify(result.issues)).not.toContain(SENTINEL);
  });
});

describe('issuesByPath', () => {
  it('indexa problemas por caminho', () => {
    const result = validateDocument(parseOrThrow('{"":1,"a":2}'), 'Standard');
    const index = issuesByPath(result);

    expect(index.get('0')?.[0]?.code).toBe('EMPTY_KEY');
    expect(index.has('1')).toBe(false);
  });

  it('agrupa múltiplos problemas do mesmo caminho', () => {
    const document = setNumberLexeme(parseOrThrow('{"":1}'), [0], 'x');
    const index = issuesByPath(validateDocument(document, 'Standard'));

    expect(index.get('0')?.map((issue) => issue.code).sort()).toEqual([
      'EMPTY_KEY',
      'INVALID_NUMBER',
    ]);
  });
});
