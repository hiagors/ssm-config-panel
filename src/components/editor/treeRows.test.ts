import { describe, expect, it } from 'vitest';
import type { JsonDocument } from '../../domain/json/JsonDocument.js';
import { parseJsonDocument } from '../../domain/json/parseJsonDocument.js';
import { pathKey } from '../../domain/json/jsonPath.js';
import {
  MAX_INLINE_DEPTH,
  allContainerKeys,
  flattenTree,
  matchesSegmentWindow,
} from './treeRows.js';

/**
 * O achatamento é o que substitui a recursão de componentes.
 *
 * Testado sem React de propósito: profundidade, escopo e filtro são lógica pura,
 * e é onde os erros de layout de árvore realmente moram.
 */

function parse(source: string): JsonDocument {
  const result = parseJsonDocument(source);
  if (!result.ok) {
    throw new Error(`parse falhou: ${result.error.code}`);
  }
  return result.document;
}

const NESTED = parse(
  JSON.stringify({
    db_connections: {
      banking: { database: 'appmax_banking_prod', schema: 'public', secret: 'x' },
      intelligence: { database: 'intel', schema: 'public', secret: 'y' },
    },
    PORT: 8080,
    ALLOWED: ['a', 'b'],
  }),
);

function flatten(
  document: JsonDocument,
  expandedKeys: readonly string[] = [],
  searchQuery = '',
  scopePath: readonly number[] = [],
) {
  return flattenTree(document, {
    scopePath,
    expanded: new Set(expandedKeys),
    searchQuery,
  });
}

function labels(document: JsonDocument, expanded: readonly string[] = [], search = ''): string[] {
  return flatten(document, expanded, search).rows.map((row) => row.label);
}

describe('achatamento básico', () => {
  it('fechado, mostra só o primeiro nível', () => {
    expect(labels(NESTED)).toEqual(['db_connections', 'PORT', 'ALLOWED']);
  });

  it('toda linha do primeiro nível tem profundidade 0', () => {
    expect(flatten(NESTED).rows.every((row) => row.depth === 0)).toBe(true);
  });

  it('expandir insere os filhos logo depois do pai, como irmãos na lista', () => {
    // É isso que permite a grade única: pai e filho são linhas irmãs, não
    // containers aninhados.
    expect(labels(NESTED, ['0'])).toEqual([
      'db_connections',
      'banking',
      'intelligence',
      'PORT',
      'ALLOWED',
    ]);
  });

  it('a profundidade cresce só nos descendentes', () => {
    const rows = flatten(NESTED, ['0']).rows;
    const byLabel = new Map(rows.map((row) => [row.label, row.depth]));

    expect(byLabel.get('db_connections')).toBe(0);
    expect(byLabel.get('banking')).toBe(1);
    expect(byLabel.get('PORT')).toBe(0);
  });

  it('expandir dois níveis achata os três', () => {
    expect(labels(NESTED, ['0', '0.0'])).toEqual([
      'db_connections',
      'banking',
      'database',
      'schema',
      'secret',
      'intelligence',
      'PORT',
      'ALLOWED',
    ]);
  });

  it('item de lista é rotulado pelo índice e marcado como tal', () => {
    const rows = flatten(NESTED, ['2']).rows;
    const items = rows.filter((row) => row.isArrayItem);

    expect(items.map((row) => row.label)).toEqual(['[0]', '[1]']);
    expect(items.every((row) => row.isArrayItem)).toBe(true);
  });

  it('escalar não é container e não tem filhos', () => {
    const port = flatten(NESTED).rows.find((row) => row.label === 'PORT');

    expect(port?.isContainer).toBe(false);
    expect(port?.childCount).toBe(0);
  });

  it('container informa a contagem de filhos para o badge', () => {
    const row = flatten(NESTED).rows.find((item) => item.label === 'db_connections');

    expect(row?.isContainer).toBe(true);
    expect(row?.childCount).toBe(2);
  });

  it('a identidade da linha é o id do nó, estável entre achatamentos', () => {
    const first = flatten(NESTED, ['0']).rows.map((row) => row.id);
    const second = flatten(NESTED, ['0']).rows.map((row) => row.id);

    expect(first).toEqual(second);
    expect(new Set(first).size).toBe(first.length);
  });

  it('informa índice e total de irmãos, para o anúncio de reordenação', () => {
    const rows = flatten(NESTED).rows;

    expect(rows.map((row) => `${row.indexInParent}/${row.siblingCount}`)).toEqual([
      '0/3',
      '1/3',
      '2/3',
    ]);
  });
});

describe('limite de profundidade e drill-in', () => {
  const DEEP = parse(JSON.stringify({ a: { b: { c: { d: { e: 1 } } } } }));

  it(`container na fronteira de ${MAX_INLINE_DEPTH} níveis vira drill-in`, () => {
    const rows = flatten(DEEP, ['0', '0.0', '0.0.0', '0.0.0.0']).rows;
    const byLabel = new Map(rows.map((row) => [row.label, row]));

    expect(byLabel.get('a')?.drillInOnly).toBe(false);
    expect(byLabel.get('b')?.drillInOnly).toBe(false);
    // `c` está na profundidade 2; expandir colocaria `d` na 3.
    expect(byLabel.get('c')?.drillInOnly).toBe(true);
  });

  it('drill-in não expande, mesmo estando no conjunto de expandidos', () => {
    // Indentar além de 3 níveis comeria a coluna de chave de 190px.
    expect(labels(DEEP, ['0', '0.0', '0.0.0'])).toEqual(['a', 'b', 'c']);
  });

  it('entrar no escopo reinicia a profundidade', () => {
    const result = flatten(DEEP, ['0'], '', [0, 0]);

    expect(result.rows.map((row) => `${row.label}@${row.depth}`)).toEqual(['c@0']);
  });

  it('o escopo permite alcançar qualquer profundidade', () => {
    const result = flatten(DEEP, [], '', [0, 0, 0, 0]);

    expect(result.rows.map((row) => row.label)).toEqual(['e']);
  });

  it('devolve os segmentos do escopo para o breadcrumb', () => {
    expect(flatten(DEEP, [], '', [0, 0]).scopeSegments).toEqual(['a', 'b']);
  });

  it('escopo que não existe mais devolve vazio, sem quebrar', () => {
    const result = flatten(DEEP, [], '', [9, 9]);

    expect(result.rows).toEqual([]);
    expect(result.scopeNode).toBeUndefined();
  });
});

describe('busca por caminho', () => {
  it('casa por segmento, mostra os ancestrais e o conteúdo do que casou', () => {
    // O ancestral entra para o resultado não ficar dentro de um pai fechado; o
    // conteúdo entra porque ver um objeto que casou e não ver os campos dele
    // seria inútil.
    expect(labels(NESTED, [], 'banking')).toEqual(['db_connections', 'banking', 'database', 'schema', 'secret']);
  });

  it('caminho composto com ponto casa segmentos consecutivos', () => {
    expect(labels(NESTED, [], 'db_connections.banking')).toEqual(['db_connections', 'banking', 'database', 'schema', 'secret']);
  });

  it('quem casa mostra os próprios campos', () => {
    // Buscar um objeto e ver a lista vazia dele seria inútil.
    expect(labels(NESTED, [], 'banking').length).toBeGreaterThan(0);

    const rows = flatten(NESTED, [], 'db_connections.banking').rows;
    const expanded = flatten(NESTED, [], 'banking').rows;

    expect(rows.some((row) => row.label === 'banking')).toBe(true);
    expect(expanded.some((row) => row.label === 'banking')).toBe(true);
  });

  it('pedaço de nome NÃO casa: só segmento completo', () => {
    // Filtro por substring traria db_connections, db_host e old_db juntos para
    // uma busca por "db". Num editor de produção o resultado precisa ser
    // exatamente o que se digitou.
    expect(labels(NESTED, [], 'bank')).toEqual([]);
    expect(labels(NESTED, [], 'banking')).toEqual(['db_connections', 'banking', 'database', 'schema', 'secret']);
  });

  it('prefixo de segmento também não casa', () => {
    expect(labels(NESTED, [], 'db_conn')).toEqual([]);
    expect(labels(NESTED, [], 'db_connections')).not.toEqual([]);
  });

  it('a busca não diferencia caixa', () => {
    expect(labels(NESTED, [], 'BANKING')).toEqual(labels(NESTED, [], 'banking'));
    expect(labels(NESTED, [], 'port')).toContain('PORT');
  });

  it('a busca ignora a expansão manual', () => {
    // Respeitar `expanded` esconderia resultado dentro de pai fechado.
    expect(labels(NESTED, [], 'banking')).toEqual(labels(NESTED, ['0'], 'banking'));
  });

  it('busca sem resultado devolve lista vazia e sinaliza', () => {
    const result = flatten(NESTED, [], 'nao-existe-em-lugar-nenhum');

    expect(result.rows).toEqual([]);
    expect(result.isEmptySearch).toBe(true);
  });

  it('busca vazia não filtra nada', () => {
    expect(flatten(NESTED, [], '   ').isEmptySearch).toBe(false);
    expect(labels(NESTED, [], '   ')).toEqual(labels(NESTED));
  });

  it('item de lista é encontrado pelo índice', () => {
    expect(labels(NESTED, [], 'allowed.1')).toEqual(['ALLOWED', '[1]']);
  });
});

describe('busca aceita as duas notações de caminho', () => {
  it('barra funciona igual a ponto', () => {
    expect(labels(NESTED, [], '/db_connections/banking')).toEqual(
      labels(NESTED, [], 'db_connections.banking'),
    );
  });

  it('um caminho copiado de mensagem de validação encontra resultado', () => {
    // As mensagens de validação e o diff usam `/a/b[0]`. Colar isso na busca
    // tem de funcionar, senão a notação dupla vira armadilha.
    const document = parse(JSON.stringify({ DATABASE: { pool: { min: 1, max: 10 } } }));

    expect(labels(document, [], '/DATABASE/pool/min')).toEqual(['DATABASE', 'pool', 'min']);
  });

  it('colchete de índice é tratado como separador', () => {
    expect(labels(NESTED, [], 'ALLOWED[1]')).toEqual(['ALLOWED', '[1]']);
  });

  it('separadores repetidos e mistos são tolerados', () => {
    for (const query of [
      'db_connections..banking',
      '/db_connections/banking/',
      'db_connections[banking]',
      '.db_connections.banking.',
    ]) {
      expect(labels(NESTED, [], query)).toEqual(['db_connections', 'banking', 'database', 'schema', 'secret']);
    }
  });
});

describe('matchesSegmentWindow', () => {
  it('consulta vazia casa qualquer coisa', () => {
    expect(matchesSegmentWindow(['a', 'b'], [])).toBe(true);
  });

  it('consulta maior que o caminho não casa', () => {
    expect(matchesSegmentWindow(['a'], ['a', 'b'])).toBe(false);
  });

  it('exige segmentos consecutivos', () => {
    // `db.min` não pode casar `db.pool.min`: pularia um nível.
    expect(matchesSegmentWindow(['db', 'pool', 'min'], ['db', 'min'])).toBe(false);
    expect(matchesSegmentWindow(['db', 'pool', 'min'], ['pool', 'min'])).toBe(true);
  });

  it('casa no meio do caminho', () => {
    expect(matchesSegmentWindow(['x', 'db', 'pool'], ['db', 'pool'])).toBe(true);
  });

  it('substring não atravessa separador', () => {
    // "abcd" existe se juntarmos "ab" e "cd", e não deve casar.
    expect(matchesSegmentWindow(['ab', 'cd'], ['abcd'])).toBe(false);
  });

  it('substring dentro de um segmento NÃO casa', () => {
    expect(matchesSegmentWindow(['db_connections'], ['conn'])).toBe(false);
    expect(matchesSegmentWindow(['db_connections'], ['db_connections'])).toBe(true);
  });
});

describe('allContainerKeys', () => {
  it('lista os containers expansíveis, respeitando o limite de profundidade', () => {
    const keys = allContainerKeys(NESTED, []);

    expect(keys).toContain(pathKey([0]));
    expect(keys).toContain(pathKey([0, 0]));
    expect(keys).toContain(pathKey([2]));
  });

  it('não inclui escalar', () => {
    // PORT é índice 1 e não é container.
    expect(allContainerKeys(NESTED, [])).not.toContain(pathKey([1]));
  });

  it('escopo inexistente devolve vazio', () => {
    expect(allContainerKeys(NESTED, [9])).toEqual([]);
  });
});
