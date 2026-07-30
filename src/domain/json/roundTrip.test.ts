import { describe, expect, it } from 'vitest';
import { parseJsonDocument } from './parseJsonDocument.js';
import { serializeJsonDocument } from './serializeJsonDocument.js';
import {
  appendEntry,
  changeNodeKind,
  moveEntry,
  removeEntry,
  renameEntry,
  setNumberLexeme,
  setStringValue,
} from './editOperations.js';
import type { JsonDocument } from './JsonDocument.js';

/**
 * O teste mais importante da fase: parse → serialize é estável.
 *
 * "Estável" aqui é forte: **byte a byte**. É o que sustenta o critério de
 * aceitação "round-trip de um parâmetro sem alterações produz diff vazio".
 */

function parseOrThrow(source: string): JsonDocument {
  const result = parseJsonDocument(source);

  if (!result.ok) {
    throw new Error(`esperava parse válido, veio ${result.error.code}`);
  }

  return result.document;
}

function roundTrip(source: string): string {
  return serializeJsonDocument(parseOrThrow(source));
}

describe('round-trip sem edição é byte-idêntico', () => {
  it.each([
    ['objeto simples', '{"a":1}'],
    ['objeto formatado', '{\n  "a": 1,\n  "b": 2\n}'],
    ['minificado', '{"a":1,"b":[1,2,3],"c":{"d":true}}'],
    ['espaçamento irregular', '{  "a" :   1  ,   "b":2   }'],
    ['indentação de 4', '{\n    "a": 1,\n    "b": {\n        "c": 2\n    }\n}'],
    ['tabs', '{\n\t"a": 1\n}'],
    ['CRLF', '{\r\n  "a": 1\r\n}'],
    ['array na raiz', '[1, "dois", true, null]'],
    ['escalar na raiz', '"só uma string"'],
    ['número na raiz', '42'],
    ['null na raiz', 'null'],
    ['objeto vazio', '{}'],
    ['array vazio', '[]'],
    ['aninhamento fundo', '{"a":{"b":{"c":{"d":{"e":1}}}}}'],
    ['array heterogêneo', '[1,"dois",false,null,{"k":"v"},[1,2]]'],
    ['unicode escapado', '{"a":"\\u00e9"}'],
    ['unicode cru', '{"a":"é"}'],
    ['escapes', '{"a":"linha\\nquebra\\ttab\\\\barra\\"aspas"}'],
    ['chave vazia', '{"":1}'],
    ['chave com ponto', '{"a.b.c":1}'],
    ['chave numérica', '{"2":"b","1":"a"}'],
    ['barra não escapada', '{"a":"http://x/y"}'],
  ])('preserva %s', (_label, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it('preserva a ordem original das chaves', () => {
    const source = '{"z":1,"a":2,"m":3}';

    expect(roundTrip(source)).toBe(source);

    const document = parseOrThrow(source);
    expect(document.root.kind === 'object' && document.root.entries.map((e) => e.key)).toEqual([
      'z',
      'a',
      'm',
    ]);
  });

  it('preserva ordem de chave que parece número', () => {
    // Objeto JS reordenaria para 1, 2, 10. A lista ordenada não.
    const source = '{"10":"dez","2":"dois","1":"um"}';

    expect(roundTrip(source)).toBe(source);

    const document = parseOrThrow(source);
    expect(document.root.kind === 'object' && document.root.entries.map((e) => e.key)).toEqual([
      '10',
      '2',
      '1',
    ]);
  });

  it('preserva chave duplicada, que JSON.parse descartaria', () => {
    const source = '{"a":1,"a":2}';

    expect(roundTrip(source)).toBe(source);
    expect(Object.keys(JSON.parse(source) as object)).toHaveLength(1);

    const document = parseOrThrow(source);
    expect(document.root.kind === 'object' && document.root.entries).toHaveLength(2);
  });

  it.each([
    ['int vs float', '{"a":30.0,"b":30}'],
    ['zeros à direita', '{"a":1.50}'],
    ['expoente', '{"a":1e5,"b":1E5,"c":1e+5,"d":1e-5}'],
    ['inteiro acima de 2^53', '{"a":9007199254740993}'],
    ['inteiro enorme', '{"a":123456789012345678901234567890}'],
    ['negativo zero', '{"a":-0}'],
    ['expoente que estouraria', '{"a":1e400}'],
  ])('preserva número: %s', (_label, source) => {
    expect(roundTrip(source)).toBe(source);
  });

  it('preserva null e string vazia como coisas distintas', () => {
    const source = '{"a":null,"b":""}';

    expect(roundTrip(source)).toBe(source);

    const document = parseOrThrow(source);
    const entries = document.root.kind === 'object' ? document.root.entries : [];

    expect(entries[0]?.value.kind).toBe('null');
    expect(entries[1]?.value.kind).toBe('string');
  });
});

describe('edição preserva o que não foi tocado', () => {
  it('editar um campo não reformata os vizinhos', () => {
    const source = '{\n  "a": 1,\n  "b": {  "x":1,   "y":2  },\n  "c": 30.0\n}';
    const document = parseOrThrow(source);

    // Muda só o "a".
    const edited = setNumberLexeme(document, [0], '99');
    const output = serializeJsonDocument(edited);

    expect(output).toContain('"a": 99');
    // O espaçamento torto do "b" sobrevive intacto.
    expect(output).toContain('"b": {  "x":1,   "y":2  }');
    // O 30.0 do "c" não virou 30.
    expect(output).toContain('"c": 30.0');
  });

  it('renomear mantém a posição na lista', () => {
    const document = parseOrThrow('{"z":1,"a":2,"m":3}');

    const output = serializeJsonDocument(renameEntry(document, [0], 'zz'));

    expect(output).toBe('{"zz":1,"a":2,"m":3}');
  });

  it('adicionar campo não mexe nos existentes', () => {
    const source = '{\n  "a": 30.0,\n  "b": 2\n}';
    const document = parseOrThrow(source);

    const output = serializeJsonDocument(appendEntry(document, [], 'novo', 'string'));

    expect(output).toContain('"a": 30.0');
    expect(output).toContain('"b": 2');
    expect(output).toContain('"novo": ""');
  });

  it('remover campo não mexe nos existentes', () => {
    const document = parseOrThrow('{\n  "a": 30.0,\n  "b": 2,\n  "c": 3\n}');

    const output = serializeJsonDocument(removeEntry(document, [1]));

    expect(output).toBe('{\n  "a": 30.0,\n  "c": 3\n}');
  });

  it('reordenar preserva o texto de cada campo', () => {
    const document = parseOrThrow('{\n  "a": 30.0,\n  "b": 1e5\n}');

    const output = serializeJsonDocument(moveEntry(document, [0], 1));

    expect(output).toBe('{\n  "b": 1e5,\n  "a": 30.0\n}');
  });

  it('documento minificado editado continua minificado', () => {
    // O caso real: parâmetros são JSON em linha única.
    const document = parseOrThrow('{"a":1,"b":{"c":2}}');

    const output = serializeJsonDocument(appendEntry(document, [], 'd', 'number'));

    expect(output).not.toContain('\n');
    expect(output).toBe('{"a":1,"b":{"c":2},"d":0}');
  });

  it('editar dentro de aninhado preserva o irmão externo', () => {
    const source = '{\n  "keep": {  "weird":  1  },\n  "edit": {\n    "x": 1\n  }\n}';
    const document = parseOrThrow(source);

    const output = serializeJsonDocument(setNumberLexeme(document, [1, 0], '2'));

    expect(output).toContain('"keep": {  "weird":  1  }');
    expect(output).toContain('"x": 2');
  });
});

describe('null vs string vazia nunca colapsam', () => {
  it('trocar null para string produz string vazia, não null', () => {
    const document = parseOrThrow('{"a":null}');

    const output = serializeJsonDocument(changeNodeKind(document, [0], 'string'));

    expect(output).toBe('{"a":""}');
  });

  it('trocar string vazia para null produz null, não string', () => {
    const document = parseOrThrow('{"a":""}');

    const output = serializeJsonDocument(changeNodeKind(document, [0], 'null'));

    expect(output).toBe('{"a":null}');
  });

  it('esvaziar uma string não a transforma em null', () => {
    const document = parseOrThrow('{"a":"texto"}');

    const output = serializeJsonDocument(setStringValue(document, [0], ''));

    expect(output).toBe('{"a":""}');
  });

  it('ida e volta entre null e string vazia é estável', () => {
    const document = parseOrThrow('{"a":null}');

    const there = changeNodeKind(document, [0], 'string');
    const back = changeNodeKind(there, [0], 'null');

    expect(serializeJsonDocument(back)).toBe('{"a":null}');
  });
});

describe('troca de tipo preserva o texto bruto', () => {
  it('texto inválido para número sobrevive, e a validação acusa', () => {
    // O caso que motiva a regra: quem digitou "abc" num campo que deveria ser
    // número quer corrigir, não redigitar. Resetar para 0 apagaria o trabalho e
    // ainda esconderia o erro.
    const document = parseOrThrow('{"a":"abc"}');

    const converted = changeNodeKind(document, [0], 'number');
    const node = converted.root.kind === 'object' ? converted.root.entries[0]?.value : undefined;

    expect(node?.kind).toBe('number');
    expect(node?.kind === 'number' && node.raw).toBe('abc');
    expect(serializeJsonDocument(converted)).toBe('{"a":abc}');
  });

  it('número para texto preserva o lexema, inclusive o que Number destruiria', () => {
    for (const [source, expected] of [
      ['{"a":30.0}', '{"a":"30.0"}'],
      ['{"a":9007199254740993}', '{"a":"9007199254740993"}'],
      ['{"a":1e5}', '{"a":"1e5"}'],
    ] as const) {
      const document = parseOrThrow(source);

      expect(serializeJsonDocument(changeNodeKind(document, [0], 'string'))).toBe(expected);
    }
  });

  it('ida e volta texto → número → texto não perde nada', () => {
    const document = parseOrThrow('{"a":"1.50"}');

    const there = changeNodeKind(document, [0], 'number');
    const back = changeNodeKind(there, [0], 'string');

    expect(serializeJsonDocument(back)).toBe('{"a":"1.50"}');
  });

  it('campo vazio não carrega nada, e continua produzindo o padrão do tipo', () => {
    expect(serializeJsonDocument(changeNodeKind(parseOrThrow('{"a":""}'), [0], 'number'))).toBe(
      '{"a":0}',
    );
  });

  it('booleano e null não têm texto, então caem no padrão', () => {
    // Interpolar "true" como texto seria inventar conteúdo que não existia.
    expect(serializeJsonDocument(changeNodeKind(parseOrThrow('{"a":true}'), [0], 'string'))).toBe(
      '{"a":""}',
    );
    expect(serializeJsonDocument(changeNodeKind(parseOrThrow('{"a":null}'), [0], 'number'))).toBe(
      '{"a":0}',
    );
  });

  it('converter para container descarta, como a UI avisa antes', () => {
    expect(serializeJsonDocument(changeNodeKind(parseOrThrow('{"a":"x"}'), [0], 'object'))).toBe(
      '{"a":{}}',
    );
  });

  it('a identidade do nó sobrevive, para o React não perder o foco', () => {
    const document = parseOrThrow('{"a":"abc"}');
    const before = document.root.kind === 'object' ? document.root.entries[0]?.value.id : undefined;

    const converted = changeNodeKind(document, [0], 'number');
    const after = converted.root.kind === 'object' ? converted.root.entries[0]?.value.id : undefined;

    expect(after).toBe(before);
  });
});

describe('reparse do que foi serializado é estável', () => {
  it('serializar, reparsear e serializar de novo dá o mesmo texto', () => {
    const source = '{\n  "a": 30.0,\n  "b": [1, "dois", null],\n  "c": {"d": true}\n}';

    const once = roundTrip(source);
    const twice = roundTrip(once);

    expect(once).toBe(source);
    expect(twice).toBe(once);
  });

  it('estável mesmo depois de editar', () => {
    const document = parseOrThrow('{"a":1,"b":2}');
    const edited = serializeJsonDocument(setNumberLexeme(document, [0], '9007199254740993'));

    expect(roundTrip(edited)).toBe(edited);
    expect(edited).toContain('9007199254740993');
  });
});
