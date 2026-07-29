import type { JsonNode, JsonNodeKind, ObjectEntry } from './JsonDocument.js';
import { kindLabel } from './JsonDocument.js';
import type { EditPath } from './jsonPath.js';
import { serializeJsonDocument } from './serializeJsonDocument.js';
import type { JsonDocument } from './JsonDocument.js';

/**
 * Diff estrutural, por caminho.
 *
 * É a visualização principal, não um complemento de diff textual. Diff por
 * linha seria inútil aqui: os parâmetros reais são JSON minificado em linha
 * única, e o "diff" de duas linhas gigantes não diz nada.
 *
 * Por caminho, também é o único formato que atende `SecureString`: dá para
 * listar **quais chaves** mudaram sem exibir os valores, porque chave e valor
 * são campos separados do resultado. Num diff textual isso é impossível — o
 * valor está no meio da linha.
 *
 * Casamento entre os dois documentos:
 *
 * - **Objeto**: por chave, não por índice. Reordenar não deve aparecer como se
 *   todos os campos tivessem mudado. Chave duplicada casa por (chave, n-ésima
 *   ocorrência), que é o melhor possível sem inventar identidade.
 * - **Lista**: por índice, porque item de lista não tem chave. Consequência
 *   assumida: inserir no começo de uma lista marca os itens seguintes como
 *   alterados. É verdade — os índices mudaram — mas é ruidoso.
 */

export type ChangeKind = 'added' | 'removed' | 'changed' | 'moved';

/** Valor de um lado do diff. Só o necessário para renderizar. */
export interface ValueSnapshot {
  readonly nodeKind: JsonNodeKind;
  /**
   * Texto do valor, já serializado.
   *
   * ATENÇÃO: pode ser conteúdo de `SecureString` decriptado. Quem renderiza
   * decide se exibe, conforme o estado de revelação. Não logue, não serialize
   * em erro.
   */
  readonly text: string;
  /** `true` para objeto ou lista, que a UI resume em vez de exibir inteiro. */
  readonly isContainer: boolean;
}

export interface Change {
  readonly kind: ChangeKind;
  /** Caminho no documento de destino; para `removed`, o caminho na base. */
  readonly path: EditPath;
  /** Caminho legível, ex.: `/DATABASE/pool/min`. */
  readonly label: string;
  readonly before: ValueSnapshot | undefined;
  readonly after: ValueSnapshot | undefined;
  /** Só em `moved`: posições de origem e destino, 1-indexadas para a UI. */
  readonly fromPosition: number | undefined;
  readonly toPosition: number | undefined;
}

export interface ChangeSet {
  readonly changes: readonly Change[];
  /**
   * `true` quando **nada** seria gravado: os dois documentos serializam para o
   * mesmo texto, byte a byte.
   *
   * Definido pelo texto e não por `changes.length`, de propósito. Os dois não
   * são equivalentes: `{"a":1}` e `{ "a" : 1 }` têm a mesma estrutura e textos
   * diferentes. Se o save olhasse `changes.length`, uma mudança deliberada de
   * formatação feita na aba crua ficaria bloqueada.
   */
  readonly isEmpty: boolean;
  /** `true` quando o texto mudou mas nenhuma estrutura mudou. */
  readonly isFormattingOnly: boolean;
}

const EMPTY_CHANGE_SET: ChangeSet = Object.freeze({
  changes: [],
  isEmpty: true,
  isFormattingOnly: false,
});

/**
 * Compara dois documentos.
 *
 * O atalho do início é o que garante o critério de aceitação "round-trip de um
 * parâmetro sem alterações produz diff vazio": se os textos serializados são
 * idênticos, não há o que comparar. Como o serializador emite verbatim o que
 * não foi editado, um documento carregado e não editado cai sempre aqui.
 */
export function structuralDiff(base: JsonDocument, target: JsonDocument): ChangeSet {
  if (serializeJsonDocument(base) === serializeJsonDocument(target)) {
    return EMPTY_CHANGE_SET;
  }

  const changes: Change[] = [];
  compareNodes(base, target, base.root, target.root, [], '', changes);

  // Chegou aqui, então os textos diferem: `isEmpty` é falso mesmo sem mudança
  // estrutural. Nesse caso a diferença é só de formatação.
  return { changes, isEmpty: false, isFormattingOnly: changes.length === 0 };
}

function compareNodes(
  baseDocument: JsonDocument,
  targetDocument: JsonDocument,
  baseNode: JsonNode,
  targetNode: JsonNode,
  path: EditPath,
  label: string,
  changes: Change[],
): void {
  if (baseNode.kind !== targetNode.kind) {
    changes.push(
      change('changed', path, label, snapshot(baseDocument, baseNode), snapshot(targetDocument, targetNode)),
    );
    return;
  }

  switch (targetNode.kind) {
    case 'object':
      compareObjects(
        baseDocument,
        targetDocument,
        baseNode as typeof targetNode,
        targetNode,
        path,
        label,
        changes,
      );
      return;

    case 'array':
      compareArrays(
        baseDocument,
        targetDocument,
        baseNode as typeof targetNode,
        targetNode,
        path,
        label,
        changes,
      );
      return;

    default: {
      const before = serializeScalar(baseDocument, baseNode);
      const after = serializeScalar(targetDocument, targetNode);

      // Comparação textual, inclusive para número: `30` e `30.0` valem o mesmo
      // mas gravam diferente, e o usuário precisa ver essa mudança.
      if (before !== after) {
        changes.push(
          change(
            'changed',
            path,
            label,
            snapshot(baseDocument, baseNode),
            snapshot(targetDocument, targetNode),
          ),
        );
      }
    }
  }
}

function compareObjects(
  baseDocument: JsonDocument,
  targetDocument: JsonDocument,
  baseNode: Extract<JsonNode, { kind: 'object' }>,
  targetNode: Extract<JsonNode, { kind: 'object' }>,
  path: EditPath,
  label: string,
  changes: Change[],
): void {
  const baseIndex = indexByKeyOccurrence(baseNode.entries);
  const targetIndex = indexByKeyOccurrence(targetNode.entries);

  // Removidos: estão na base e não no destino. Emitidos primeiro para a lista
  // de mudanças ler na ordem em que o campo aparecia.
  for (const [identity, baseEntry] of baseIndex) {
    if (!targetIndex.has(identity)) {
      const entryPath = [...path, baseEntry.index];
      changes.push(
        change(
          'removed',
          entryPath,
          `${label}/${displayKey(baseEntry.entry.key)}`,
          snapshot(baseDocument, baseEntry.entry.value),
          undefined,
        ),
      );
    }
  }

  for (const [identity, targetEntry] of targetIndex) {
    const entryPath = [...path, targetEntry.index];
    const entryLabel = `${label}/${displayKey(targetEntry.entry.key)}`;
    const baseEntry = baseIndex.get(identity);

    if (baseEntry === undefined) {
      changes.push(
        change('added', entryPath, entryLabel, undefined, snapshot(targetDocument, targetEntry.entry.value)),
      );
      continue;
    }

    if (baseEntry.index !== targetEntry.index) {
      changes.push({
        kind: 'moved',
        path: entryPath,
        label: entryLabel,
        before: undefined,
        after: undefined,
        fromPosition: baseEntry.index + 1,
        toPosition: targetEntry.index + 1,
      });
    }

    compareNodes(
      baseDocument,
      targetDocument,
      baseEntry.entry.value,
      targetEntry.entry.value,
      entryPath,
      entryLabel,
      changes,
    );
  }
}

function compareArrays(
  baseDocument: JsonDocument,
  targetDocument: JsonDocument,
  baseNode: Extract<JsonNode, { kind: 'array' }>,
  targetNode: Extract<JsonNode, { kind: 'array' }>,
  path: EditPath,
  label: string,
  changes: Change[],
): void {
  const shared = Math.min(baseNode.items.length, targetNode.items.length);

  for (let index = 0; index < shared; index += 1) {
    compareNodes(
      baseDocument,
      targetDocument,
      baseNode.items[index] as JsonNode,
      targetNode.items[index] as JsonNode,
      [...path, index],
      `${label}[${index}]`,
      changes,
    );
  }

  for (let index = shared; index < targetNode.items.length; index += 1) {
    changes.push(
      change(
        'added',
        [...path, index],
        `${label}[${index}]`,
        undefined,
        snapshot(targetDocument, targetNode.items[index] as JsonNode),
      ),
    );
  }

  for (let index = shared; index < baseNode.items.length; index += 1) {
    changes.push(
      change(
        'removed',
        [...path, index],
        `${label}[${index}]`,
        snapshot(baseDocument, baseNode.items[index] as JsonNode),
        undefined,
      ),
    );
  }
}

interface IndexedEntry {
  readonly entry: ObjectEntry;
  readonly index: number;
}

/**
 * Indexa entradas por `chave#ocorrência`.
 *
 * A ocorrência permite casar chave duplicada de forma estável. Não é
 * identidade de verdade — se alguém renomeia uma das duas, o casamento erra —
 * mas duplicata bloqueia o save na validação, então é estado transitório.
 */
function indexByKeyOccurrence(entries: readonly ObjectEntry[]): Map<string, IndexedEntry> {
  const seen = new Map<string, number>();
  const index = new Map<string, IndexedEntry>();

  entries.forEach((entry, position) => {
    const occurrence = (seen.get(entry.key) ?? 0) + 1;
    seen.set(entry.key, occurrence);
    index.set(`${entry.key}#${occurrence}`, { entry, index: position });
  });

  return index;
}

function change(
  kind: ChangeKind,
  path: EditPath,
  label: string,
  before: ValueSnapshot | undefined,
  after: ValueSnapshot | undefined,
): Change {
  return {
    kind,
    path,
    label: label === '' ? '(raiz)' : label,
    before,
    after,
    fromPosition: undefined,
    toPosition: undefined,
  };
}

function displayKey(key: string): string {
  return key === '' ? '(chave vazia)' : key;
}

function snapshot(document: JsonDocument, node: JsonNode): ValueSnapshot {
  const isContainer = node.kind === 'object' || node.kind === 'array';

  return {
    nodeKind: node.kind,
    text: isContainer ? summarizeContainer(node) : serializeScalar(document, node),
    isContainer,
  };
}

/** Resumo de container, para o diff não despejar uma subárvore inteira. */
function summarizeContainer(node: JsonNode): string {
  if (node.kind === 'object') {
    const count = node.entries.length;
    return `${kindLabel('object')} com ${count} ${count === 1 ? 'campo' : 'campos'}`;
  }
  if (node.kind === 'array') {
    const count = node.items.length;
    return `${kindLabel('array')} com ${count} ${count === 1 ? 'item' : 'itens'}`;
  }
  return '';
}

/**
 * Texto de um escalar.
 *
 * Usa o mesmo caminho de serialização do save, então o diff mostra exatamente
 * o que vai ser gravado — inclusive o lexema do número preservado.
 */
function serializeScalar(document: JsonDocument, node: JsonNode): string {
  switch (node.kind) {
    case 'string':
      return node.value;
    case 'number':
      return node.raw;
    case 'boolean':
      return node.value ? 'true' : 'false';
    case 'null':
      return 'null';
    default:
      return serializeJsonDocument({ ...document, root: node });
  }
}

/**
 * Diff de três vias, para o caso de alteração externa.
 *
 * Compara a base carregada contra a versão atual do store e contra a minha
 * edição, e classifica cada caminho:
 *
 * - `mine` — só eu mudei. Gravar preserva a intenção de todos.
 * - `theirs` — só a outra pessoa mudou. Gravar apagaria a mudança dela.
 * - `both` — os dois mudamos o mesmo caminho. Conflito de verdade.
 *
 * Sem essa separação o usuário só saberia que "algo mudou" e teria de comparar
 * dois JSON à mão para decidir.
 */
export interface ThreeWayChange {
  readonly label: string;
  readonly side: 'mine' | 'theirs' | 'both';
  readonly base: ValueSnapshot | undefined;
  readonly current: ValueSnapshot | undefined;
  readonly mine: ValueSnapshot | undefined;
}

export interface ThreeWayDiff {
  readonly changes: readonly ThreeWayChange[];
  /** `true` quando nenhum caminho foi tocado pelos dois lados. */
  readonly isMergeableWithoutConflict: boolean;
}

export function threeWayDiff(
  base: JsonDocument,
  current: JsonDocument,
  mine: JsonDocument,
): ThreeWayDiff {
  const theirChanges = new Map<string, Change>();
  for (const item of structuralDiff(base, current).changes) {
    theirChanges.set(item.label, item);
  }

  const myChanges = new Map<string, Change>();
  for (const item of structuralDiff(base, mine).changes) {
    myChanges.set(item.label, item);
  }

  const labels = [...new Set([...theirChanges.keys(), ...myChanges.keys()])].sort();
  const changes: ThreeWayChange[] = [];

  for (const label of labels) {
    const theirs = theirChanges.get(label);
    const own = myChanges.get(label);

    const side: ThreeWayChange['side'] =
      theirs !== undefined && own !== undefined ? 'both' : theirs !== undefined ? 'theirs' : 'mine';

    changes.push({
      label,
      side,
      base: theirs?.before ?? own?.before,
      current: theirs?.after,
      mine: own?.after,
    });
  }

  return {
    changes,
    isMergeableWithoutConflict: !changes.some((item) => item.side === 'both'),
  };
}
