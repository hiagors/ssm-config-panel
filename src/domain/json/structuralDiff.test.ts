import { describe, expect, it } from 'vitest';
import type { JsonDocument } from './JsonDocument.js';
import { parseJsonDocument } from './parseJsonDocument.js';
import { structuralDiff, threeWayDiff } from './structuralDiff.js';
import {
  appendEntry,
  changeNodeKind,
  moveEntry,
  removeEntry,
  renameEntry,
  setNumberLexeme,
  setStringValue,
} from './editOperations.js';

function parse(source: string): JsonDocument {
  const result = parseJsonDocument(source);
  if (!result.ok) {
    throw new Error(`parse falhou: ${result.error.code}`);
  }
  return result.document;
}

function diffOf(before: string, after: string) {
  return structuralDiff(parse(before), parse(after));
}

/** Atalho: `alterado /a` etc., para asserção legível. */
function summary(before: string, after: string): string[] {
  return diffOf(before, after).changes.map((change) => `${change.kind} ${change.label}`);
}

describe('diff vazio', () => {
  it('documento idêntico não tem mudança', () => {
    expect(diffOf('{"a":1}', '{"a":1}').isEmpty).toBe(true);
  });

  it('documento carregado e não editado produz diff vazio', () => {
    // O critério de aceitação. Vale porque o serializador emite verbatim o que
    // não foi editado.
    const source = '{\n  "a": 30.0,\n  "b": {  "x":1,   "y":2  },\n  "c": [1,2,3]\n}';
    const document = parse(source);

    expect(structuralDiff(document, document).isEmpty).toBe(true);
  });

  it('editar e desfazer produz diff vazio', () => {
    const base = parse('{"a":1}');
    const edited = setNumberLexeme(setNumberLexeme(base, [0], '2'), [0], '1');

    expect(structuralDiff(base, edited).isEmpty).toBe(true);
  });

  it('diferença só de formatação não conta como vazia, porque muda o que se grava', () => {
    // Estrutura idêntica, texto diferente. `isEmpty` é definido pelo texto, não
    // por `changes.length`: senão minificar ou reindentar na aba crua ficaria
    // com o save bloqueado.
    const diff = diffOf('{"a":1}', '{ "a" : 1 }');

    expect(diff.isEmpty).toBe(false);
    expect(diff.isFormattingOnly).toBe(true);
    expect(diff.changes).toEqual([]);
  });

  it('mudança real não é marcada como só de formatação', () => {
    const diff = diffOf('{"a":1}', '{"a":2}');

    expect(diff.isEmpty).toBe(false);
    expect(diff.isFormattingOnly).toBe(false);
  });

  it('documento idêntico não é nem vazio-por-formatação', () => {
    const diff = diffOf('{"a":1}', '{"a":1}');

    expect(diff.isEmpty).toBe(true);
    expect(diff.isFormattingOnly).toBe(false);
  });
});

describe('mudança de escalar', () => {
  it('detecta valor alterado', () => {
    expect(summary('{"a":1}', '{"a":2}')).toEqual(['changed /a']);
  });

  it('mostra antes e depois', () => {
    const change = diffOf('{"a":"antigo"}', '{"a":"novo"}').changes[0];

    expect(change?.before?.text).toBe('antigo');
    expect(change?.after?.text).toBe('novo');
  });

  it('detecta mudança de tipo', () => {
    const change = diffOf('{"a":1}', '{"a":"1"}').changes[0];

    expect(change?.kind).toBe('changed');
    expect(change?.before?.nodeKind).toBe('number');
    expect(change?.after?.nodeKind).toBe('string');
  });

  it('distingue null de string vazia', () => {
    expect(diffOf('{"a":null}', '{"a":""}').isEmpty).toBe(false);
    expect(diffOf('{"a":""}', '{"a":null}').isEmpty).toBe(false);
  });

  it('30 e 30.0 contam como mudança, porque gravam diferente', () => {
    const change = diffOf('{"a":30}', '{"a":30.0}').changes[0];

    expect(change?.kind).toBe('changed');
    expect(change?.before?.text).toBe('30');
    expect(change?.after?.text).toBe('30.0');
  });

  it('inteiro acima de 2^53 é comparado como texto', () => {
    expect(diffOf('{"a":9007199254740993}', '{"a":9007199254740992}').isEmpty).toBe(false);
    expect(diffOf('{"a":9007199254740993}', '{"a":9007199254740993}').isEmpty).toBe(true);
  });
});

describe('adição e remoção', () => {
  it('detecta campo adicionado', () => {
    expect(summary('{"a":1}', '{"a":1,"b":2}')).toEqual(['added /b']);
  });

  it('detecta campo removido', () => {
    expect(summary('{"a":1,"b":2}', '{"a":1}')).toEqual(['removed /b']);
  });

  it('renomear aparece como remoção mais adição', () => {
    const changes = summary('{"a":1}', '{"b":1}');

    expect(changes).toContain('removed /a');
    expect(changes).toContain('added /b');
  });

  it('resume container em vez de despejar a subárvore', () => {
    const change = diffOf('{}', '{"o":{"x":1,"y":2}}').changes[0];

    expect(change?.after?.isContainer).toBe(true);
    expect(change?.after?.text).toBe('objeto com 2 campos');
  });

  it('nomeia chave vazia de forma legível', () => {
    expect(summary('{}', '{"":1}')).toEqual(['added /(chave vazia)']);
  });
});

describe('reordenação', () => {
  it('mover campo aparece como moved, não como tudo alterado', () => {
    // Casar por chave é o que evita esse ruído.
    expect(summary('{"a":1,"b":2}', '{"b":2,"a":1}')).toEqual(['moved /b', 'moved /a']);
  });

  it('moved informa as posições', () => {
    const change = diffOf('{"a":1,"b":2}', '{"b":2,"a":1}').changes[0];

    expect(change?.kind).toBe('moved');
    expect(change?.fromPosition).toBe(2);
    expect(change?.toPosition).toBe(1);
  });

  it('mover e alterar o mesmo campo gera as duas mudanças', () => {
    const changes = summary('{"a":1,"b":2}', '{"b":9,"a":1}');

    expect(changes).toContain('moved /b');
    expect(changes).toContain('changed /b');
  });
});

describe('aninhamento', () => {
  it('aponta o caminho completo do campo alterado', () => {
    expect(summary('{"a":{"b":{"c":1}}}', '{"a":{"b":{"c":2}}}')).toEqual(['changed /a/b/c']);
  });

  it('não reporta ancestral não alterado', () => {
    expect(diffOf('{"a":{"b":1},"z":9}', '{"a":{"b":2},"z":9}').changes).toHaveLength(1);
  });

  it('usa notação de índice em lista', () => {
    expect(summary('{"a":[1,2,3]}', '{"a":[1,9,3]}')).toEqual(['changed /a[1]']);
  });

  it('detecta item adicionado no fim da lista', () => {
    expect(summary('{"a":[1]}', '{"a":[1,2]}')).toEqual(['added /a[1]']);
  });

  it('detecta item removido do fim da lista', () => {
    expect(summary('{"a":[1,2]}', '{"a":[1]}')).toEqual(['removed /a[1]']);
  });

  it('inserir no começo da lista marca os índices seguintes — limitação assumida', () => {
    // Item de lista não tem chave, então o casamento é por índice. Verdadeiro,
    // mas ruidoso; documentado no README.
    const changes = summary('{"a":[1,2]}', '{"a":[0,1,2]}');

    expect(changes).toContain('changed /a[0]');
    expect(changes).toContain('changed /a[1]');
    expect(changes).toContain('added /a[2]');
  });

  it('objeto dentro de lista tem caminho completo', () => {
    expect(summary('{"a":[{"k":1}]}', '{"a":[{"k":2}]}')).toEqual(['changed /a[0]/k']);
  });
});

describe('chave duplicada', () => {
  it('casa por ocorrência', () => {
    expect(diffOf('{"a":1,"a":2}', '{"a":1,"a":3}').changes.map((c) => c.label)).toEqual(['/a']);
  });
});

describe('diff a partir de operações de edição', () => {
  it('acompanha uma sessão de edição completa', () => {
    const base = parse('{"keep":1,"rename":2,"remove":3,"nested":{"x":1}}');

    let edited = setStringValue(base, [0], 'texto');
    edited = changeNodeKind(edited, [0], 'string');
    edited = setStringValue(edited, [0], 'texto');
    edited = renameEntry(edited, [1], 'renamed');
    edited = removeEntry(edited, [2]);
    edited = appendEntry(edited, [], 'novo', 'boolean');
    edited = setNumberLexeme(edited, [2, 0], '9007199254740993');

    const labels = structuralDiff(base, edited).changes.map((c) => `${c.kind} ${c.label}`);

    expect(labels).toContain('changed /keep');
    expect(labels).toContain('removed /rename');
    expect(labels).toContain('added /renamed');
    expect(labels).toContain('removed /remove');
    expect(labels).toContain('added /novo');
    expect(labels).toContain('changed /nested/x');
  });

  it('mover entrada não gera mudança de valor', () => {
    const base = parse('{"a":1,"b":2,"c":3}');
    const moved = moveEntry(base, [0], 2);

    const kinds = new Set(structuralDiff(base, moved).changes.map((c) => c.kind));

    expect(kinds.has('changed')).toBe(false);
    expect(kinds.has('moved')).toBe(true);
  });
});

describe('threeWayDiff', () => {
  const BASE = '{"a":1,"b":2,"c":3}';

  it('separa o que só eu mudei do que só o outro mudou', () => {
    const diff = threeWayDiff(parse(BASE), parse('{"a":1,"b":99,"c":3}'), parse('{"a":42,"b":2,"c":3}'));

    const bySide = new Map(diff.changes.map((change) => [change.label, change.side]));

    expect(bySide.get('/a')).toBe('mine');
    expect(bySide.get('/b')).toBe('theirs');
  });

  it('marca conflito quando os dois mudam o mesmo caminho', () => {
    const diff = threeWayDiff(parse(BASE), parse('{"a":10,"b":2,"c":3}'), parse('{"a":20,"b":2,"c":3}'));

    expect(diff.changes.find((change) => change.label === '/a')?.side).toBe('both');
    expect(diff.isMergeableWithoutConflict).toBe(false);
  });

  it('mudanças em caminhos distintos são mescláveis', () => {
    const diff = threeWayDiff(parse(BASE), parse('{"a":1,"b":99,"c":3}'), parse('{"a":42,"b":2,"c":3}'));

    expect(diff.isMergeableWithoutConflict).toBe(true);
  });

  it('traz os três lados de um conflito', () => {
    const diff = threeWayDiff(
      parse('{"a":"base"}'),
      parse('{"a":"deles"}'),
      parse('{"a":"meu"}'),
    );
    const change = diff.changes.find((candidate) => candidate.label === '/a');

    expect(change?.base?.text).toBe('base');
    expect(change?.current?.text).toBe('deles');
    expect(change?.mine?.text).toBe('meu');
  });

  it('mudança idêntica dos dois lados ainda aparece como conflito de caminho', () => {
    // Não tentamos adivinhar que "é a mesma coisa": o usuário decide.
    const diff = threeWayDiff(parse('{"a":1}'), parse('{"a":2}'), parse('{"a":2}'));

    expect(diff.changes.find((change) => change.label === '/a')?.side).toBe('both');
  });

  it('sem alteração externa, só aparece o meu lado', () => {
    const diff = threeWayDiff(parse(BASE), parse(BASE), parse('{"a":42,"b":2,"c":3}'));

    expect(diff.changes.map((change) => change.side)).toEqual(['mine']);
    expect(diff.isMergeableWithoutConflict).toBe(true);
  });
});
