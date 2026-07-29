import { describe, expect, it } from 'vitest';
import { parseJsonDocument } from './parseJsonDocument.js';

const SENTINEL = 'SENTINEL-parser-a91f3c-DO-NOT-LEAK';

function expectFailure(source: string) {
  const result = parseJsonDocument(source);

  if (result.ok) {
    throw new Error('esperava falha de parse');
  }

  return result.error;
}

describe('parseJsonDocument — gramática', () => {
  it.each([
    ['objeto', '{"a":1}'],
    ['array', '[1,2]'],
    ['string', '"x"'],
    ['número', '1'],
    ['true', 'true'],
    ['false', 'false'],
    ['null', 'null'],
    ['aninhado', '{"a":[{"b":null}]}'],
    ['com espaço em volta', '  {"a":1}  '],
  ])('aceita %s', (_label, source) => {
    expect(parseJsonDocument(source).ok).toBe(true);
  });

  it.each([
    ['vazio', '', 'EMPTY_INPUT'],
    ['só espaço', '   ', 'EMPTY_INPUT'],
    ['vírgula sobrando em objeto', '{"a":1,}', 'TRAILING_COMMA'],
    ['vírgula sobrando em array', '[1,2,]', 'TRAILING_COMMA'],
    ['chave sem aspas', '{a:1}', 'EXPECTED_KEY'],
    ['dois-pontos ausente', '{"a" 1}', 'MISSING_COLON'],
    ['objeto não fechado', '{"a":1', 'UNEXPECTED_END'],
    ['string não fechada', '{"a":"x}', 'INVALID_STRING'],
    ['conteúdo depois do fim', '{"a":1} lixo', 'TRAILING_CONTENT'],
    ['zero à esquerda', '{"a":01}', 'INVALID_NUMBER'],
    ['ponto sem dígito', '{"a":1.}', 'INVALID_NUMBER'],
    ['expoente incompleto', '{"a":1e}', 'INVALID_NUMBER'],
    ['escape desconhecido', '{"a":"\\q"}', 'INVALID_ESCAPE'],
    ['\\u incompleto', '{"a":"\\u12"}', 'INVALID_ESCAPE'],
    ['literal errado', '{"a":tru}', 'INVALID_LITERAL'],
    ['aspas simples', "{'a':1}", 'EXPECTED_KEY'],
  ])('rejeita %s com código %s', (_label, source, code) => {
    expect(expectFailure(source).code).toBe(code);
  });

  it('rejeita comentário, sem tentar consertar', () => {
    expect(parseJsonDocument('{"a":1} // nota').ok).toBe(false);
    expect(parseJsonDocument('{/* c */"a":1}').ok).toBe(false);
  });

  it('rejeita controle cru dentro de string', () => {
    expect(expectFailure('{"a":"x\ny"}').code).toBe('INVALID_STRING');
  });
});

describe('parseJsonDocument — erro não vaza conteúdo', () => {
  it('a mensagem traz posição, nunca o trecho', () => {
    // Este é o vazamento que a mensagem nativa do JSON.parse comete.
    const error = expectFailure(`{"token": "${SENTINEL}"`);

    expect(error.message).not.toContain(SENTINEL);
    expect(error.message).toMatch(/linha \d+, coluna \d+/);
  });

  it('nenhum campo do erro contém o conteúdo', () => {
    const error = expectFailure(`{"a": "${SENTINEL}", }`);

    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  it('o mesmo vale para conteúdo em chave', () => {
    const error = expectFailure(`{"${SENTINEL}": }`);

    expect(JSON.stringify(error)).not.toContain(SENTINEL);
  });

  it('a mensagem nativa do JSON.parse vazaria — a prova', () => {
    // O V8 embute um trecho da entrada em erros de token inesperado, truncado
    // em ~16 caracteres. Segredo curto vaza inteiro; segredo longo vaza um
    // prefixo — que ainda é vazamento.
    const short = 'sk-live-42';
    const shortMessage = messageOf(() => JSON.parse(short));

    expect(shortMessage).toContain(short);

    const longMessage = messageOf(() => JSON.parse(`[${SENTINEL}]`));

    expect(longMessage).toContain(SENTINEL.slice(0, 8));
    // E o nosso parser não repassa nem o prefixo.
    expect(expectFailure(`[${SENTINEL}]`).message).not.toContain(SENTINEL.slice(0, 8));
  });
});

function messageOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : '';
  }
  throw new Error('esperava exceção');
}

describe('parseJsonDocument — posição do erro', () => {
  it('aponta linha e coluna corretas', () => {
    const error = expectFailure('{\n  "a": 1,\n  "b": tru\n}');

    expect(error.line).toBe(3);
    expect(error.column).toBe(8);
  });

  it('linha 1 para documento em linha única', () => {
    expect(expectFailure('{"a":}').line).toBe(1);
  });
});

describe('parseJsonDocument — spans e indentação', () => {
  it('registra span da raiz cobrindo o documento', () => {
    const result = parseJsonDocument('{"a":1}');

    expect(result.ok && result.document.root.span).toEqual({ start: 0, end: 7 });
  });

  it('detecta a unidade de indentação', () => {
    const twoSpaces = parseJsonDocument('{\n  "a": 1\n}');
    const fourSpaces = parseJsonDocument('{\n    "a": 1\n}');
    const tab = parseJsonDocument('{\n\t"a": 1\n}');

    expect(twoSpaces.ok && twoSpaces.document.style.indentUnit).toBe('  ');
    expect(fourSpaces.ok && fourSpaces.document.style.indentUnit).toBe('    ');
    expect(tab.ok && tab.document.style.indentUnit).toBe('\t');
  });

  it('usa 2 espaços como padrão em documento minificado', () => {
    const result = parseJsonDocument('{"a":1}');

    expect(result.ok && result.document.style.indentUnit).toBe('  ');
  });

  it('detecta o separador de chave do minificado', () => {
    const minified = parseJsonDocument('{"a":1,"b":2}');
    const spaced = parseJsonDocument('{"a": 1, "b": 2}');

    expect(minified.ok && minified.document.style.keySeparator).toBe(':');
    expect(spaced.ok && spaced.document.style.keySeparator).toBe(': ');
  });

  it('detecta o separador entre itens', () => {
    const minified = parseJsonDocument('{"a":1,"b":2}');
    const spaced = parseJsonDocument('{"a":1, "b":2}');

    expect(minified.ok && minified.document.style.inlineSeparator).toBe(',');
    expect(spaced.ok && spaced.document.style.inlineSeparator).toBe(', ');
  });

  it('todo nó nasce limpo', () => {
    const result = parseJsonDocument('{"a":{"b":[1]}}');

    expect(result.ok && result.document.root.dirty).toBe(false);
    expect(
      result.ok && result.document.root.kind === 'object' && result.document.root.entries[0]?.dirty,
    ).toBe(false);
  });
});

describe('parseJsonDocument — decodificação de string', () => {
  it('decodifica escapes para o valor de edição', () => {
    const result = parseJsonDocument('{"a":"linha\\nquebra\\ttab"}');
    const entry =
      result.ok && result.document.root.kind === 'object'
        ? result.document.root.entries[0]
        : undefined;

    expect(entry?.value.kind === 'string' && entry.value.value).toBe('linha\nquebra\ttab');
  });

  it('decodifica \\u', () => {
    const result = parseJsonDocument('{"a":"\\u00e9"}');
    const entry =
      result.ok && result.document.root.kind === 'object'
        ? result.document.root.entries[0]
        : undefined;

    expect(entry?.value.kind === 'string' && entry.value.value).toBe('é');
  });

  it('decodifica a chave também', () => {
    const result = parseJsonDocument('{"a\\nb":1}');
    const entry =
      result.ok && result.document.root.kind === 'object'
        ? result.document.root.entries[0]
        : undefined;

    expect(entry?.key).toBe('a\nb');
  });
});
