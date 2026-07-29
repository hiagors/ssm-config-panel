import { useState } from 'react';
import type { JsonNode, JsonNodeKind, ObjectEntry } from '../../domain/json/JsonDocument.js';
import { childCount, kindLabel } from '../../domain/json/JsonDocument.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import { childPath, pathKey } from '../../domain/json/jsonPath.js';
import { isValidNumberLexeme } from '../../domain/json/jsonNumber.js';
import {
  appendEntry,
  appendItem,
  changeNodeKind,
  moveEntry,
  moveItem,
  removeEntry,
  removeItem,
  renameEntry,
  setBooleanValue,
  setNumberLexeme,
  setStringValue,
} from '../../domain/json/editOperations.js';
import { useEditor } from './EditorContext.js';
import TypeSelector from './TypeSelector.js';
import ValueInput from './ValueInput.js';

/**
 * Formulário recursivo de chave-valor.
 *
 * Objeto, lista e escalar vivem no mesmo módulo porque a recursão é mútua:
 * um objeto contém valores, e um valor pode ser um objeto. Separar em
 * arquivos criaria import circular sem ganho de clareza.
 *
 * Reordenar é por botão sobe/desce, não drag-and-drop: funciona por teclado,
 * é testável e não depende de biblioteca.
 */

// ─── objeto ──────────────────────────────────────────────────────────────────

export function ObjectEditor({
  node,
  path,
}: {
  readonly node: Extract<JsonNode, { kind: 'object' }>;
  readonly path: EditPath;
}) {
  const { edit } = useEditor();

  return (
    <div className="kv-block">
      {node.entries.length === 0 && (
        <p className="muted kv-empty">Objeto vazio.</p>
      )}

      {node.entries.map((entry, index) => (
        <EntryRow
          key={entry.id}
          entry={entry}
          index={index}
          total={node.entries.length}
          path={childPath(path, index)}
        />
      ))}

      <button
        type="button"
        className="secondary kv-add"
        onClick={() => edit((document) => appendEntry(document, path, '', 'string'))}
      >
        + Adicionar campo
      </button>
    </div>
  );
}

function EntryRow({
  entry,
  index,
  total,
  path,
}: {
  readonly entry: ObjectEntry;
  readonly index: number;
  readonly total: number;
  readonly path: EditPath;
}) {
  const { edit, issuesByPath } = useEditor();
  const issues = issuesByPath.get(pathKey(path)) ?? [];
  const hasError = issues.some((issue) => issue.severity === 'error');

  return (
    <div className={`kv-row${hasError ? ' has-error' : ''}`}>
      <div className="kv-reorder">
        <button
          type="button"
          className="icon"
          aria-label={`Mover ${entry.key || 'campo'} para cima`}
          disabled={index === 0}
          onClick={() => edit((document) => moveEntry(document, path, -1))}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon"
          aria-label={`Mover ${entry.key || 'campo'} para baixo`}
          disabled={index === total - 1}
          onClick={() => edit((document) => moveEntry(document, path, 1))}
        >
          ↓
        </button>
      </div>

      <input
        type="text"
        className={`key-input${hasError ? ' invalid' : ''}`}
        value={entry.key}
        onChange={(event) =>
          edit((document) => renameEntry(document, path, event.target.value))
        }
        aria-label={`Chave do campo ${index + 1}`}
        placeholder="chave"
        autoComplete="off"
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
      />

      <TypeSelector
        kind={entry.value.kind}
        ariaLabel={`Tipo de ${entry.key || `campo ${index + 1}`}`}
        onChange={(kind) => edit((document) => changeNodeKind(document, path, kind))}
      />

      <ValueField node={entry.value} path={path} label={entry.key || `campo ${index + 1}`} />

      <button
        type="button"
        className="icon danger"
        aria-label={`Remover ${entry.key || `campo ${index + 1}`}`}
        onClick={() => edit((document) => removeEntry(document, path))}
      >
        ✕
      </button>

      {issues.length > 0 && (
        <ul className="kv-issues">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`} className={issue.severity}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── lista ───────────────────────────────────────────────────────────────────

export function ArrayEditor({
  node,
  path,
}: {
  readonly node: Extract<JsonNode, { kind: 'array' }>;
  readonly path: EditPath;
}) {
  const { edit } = useEditor();

  return (
    <div className="kv-block">
      {node.items.length === 0 && <p className="muted kv-empty">Lista vazia.</p>}

      {node.items.map((item, index) => (
        <ItemRow
          key={item.id}
          item={item}
          index={index}
          total={node.items.length}
          path={childPath(path, index)}
        />
      ))}

      <button
        type="button"
        className="secondary kv-add"
        onClick={() => edit((document) => appendItem(document, path, 'string'))}
      >
        + Adicionar item
      </button>
    </div>
  );
}

function ItemRow({
  item,
  index,
  total,
  path,
}: {
  readonly item: JsonNode;
  readonly index: number;
  readonly total: number;
  readonly path: EditPath;
}) {
  const { edit, issuesByPath } = useEditor();
  const issues = issuesByPath.get(pathKey(path)) ?? [];
  const hasError = issues.some((issue) => issue.severity === 'error');

  return (
    <div className={`kv-row${hasError ? ' has-error' : ''}`}>
      <div className="kv-reorder">
        <button
          type="button"
          className="icon"
          aria-label={`Mover item ${index} para cima`}
          disabled={index === 0}
          onClick={() => edit((document) => moveItem(document, path, -1))}
        >
          ↑
        </button>
        <button
          type="button"
          className="icon"
          aria-label={`Mover item ${index} para baixo`}
          disabled={index === total - 1}
          onClick={() => edit((document) => moveItem(document, path, 1))}
        >
          ↓
        </button>
      </div>

      <span className="item-index">[{index}]</span>

      <TypeSelector
        kind={item.kind}
        ariaLabel={`Tipo do item ${index}`}
        onChange={(kind) => edit((document) => changeNodeKind(document, path, kind))}
      />

      <ValueField node={item} path={path} label={`item ${index}`} />

      <button
        type="button"
        className="icon danger"
        aria-label={`Remover item ${index}`}
        onClick={() => edit((document) => removeItem(document, path))}
      >
        ✕
      </button>

      {issues.length > 0 && (
        <ul className="kv-issues">
          {issues.map((issue) => (
            <li key={`${issue.code}-${issue.message}`} className={issue.severity}>
              {issue.message}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ─── valor ───────────────────────────────────────────────────────────────────

function ValueField({
  node,
  path,
  label,
}: {
  readonly node: JsonNode;
  readonly path: EditPath;
  readonly label: string;
}) {
  switch (node.kind) {
    case 'object':
    case 'array':
      return <NestedPanel node={node} path={path} label={label} />;
    default:
      return <ScalarField node={node} path={path} label={label} />;
  }
}

function ScalarField({
  node,
  path,
  label,
}: {
  readonly node: JsonNode;
  readonly path: EditPath;
  readonly label: string;
}) {
  const { edit, isSecret, isRevealed, toggleRevealPath } = useEditor();
  const revealed = isRevealed(path);
  const masked = isSecret && !revealed;

  return (
    <div className="value-cell">
      {node.kind === 'string' && (
        <ValueInput
          value={node.value}
          masked={masked}
          ariaLabel={`Valor de ${label}`}
          onChange={(value) => edit((document) => setStringValue(document, path, value))}
        />
      )}

      {node.kind === 'number' && (
        <ValueInput
          value={node.raw}
          numeric
          masked={masked}
          invalid={!isValidNumberLexeme(node.raw)}
          ariaLabel={`Valor de ${label}`}
          onChange={(raw) => edit((document) => setNumberLexeme(document, path, raw))}
        />
      )}

      {node.kind === 'boolean' && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={masked ? false : node.value}
            disabled={masked}
            aria-label={`Valor de ${label}`}
            onChange={(event) =>
              edit((document) => setBooleanValue(document, path, event.target.checked))
            }
          />
          <span>{masked ? '•••' : node.value ? 'true' : 'false'}</span>
        </label>
      )}

      {node.kind === 'null' && (
        <ValueInput
          value="null"
          disabled
          ariaLabel={`Valor de ${label} (null)`}
          onChange={() => undefined}
        />
      )}

      {isSecret && node.kind !== 'null' && (
        <button
          type="button"
          className="icon reveal"
          aria-label={`${revealed ? 'Ocultar' : 'Revelar'} valor de ${label}`}
          onClick={() => toggleRevealPath(path)}
        >
          {revealed ? '🙈' : '👁'}
        </button>
      )}
    </div>
  );
}

/**
 * Painel aninhado.
 *
 * Objeto e lista abrem o mesmo componente de chave-valor, recursivamente —
 * é o que permite editar 3 níveis sem tocar em texto cru. Começa fechado a
 * partir do terceiro nível para a tela não explodir.
 */
function NestedPanel({
  node,
  path,
  label,
}: {
  readonly node: Extract<JsonNode, { kind: 'object' | 'array' }>;
  readonly path: EditPath;
  readonly label: string;
}) {
  const [open, setOpen] = useState(path.length < 2);
  const count = childCount(node);
  const unit = node.kind === 'object' ? 'campo' : 'item';

  return (
    <div className="nested">
      <button
        type="button"
        className="secondary nested-toggle"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        {open ? '▾' : '▸'} {kindLabel(node.kind)} · {count} {unit}
        {count === 1 ? '' : 's'}
      </button>

      {open && (
        <div className="nested-body" role="group" aria-label={`Conteúdo de ${label}`}>
          {node.kind === 'object' ? (
            <ObjectEditor node={node} path={path} />
          ) : (
            <ArrayEditor node={node} path={path} />
          )}
        </div>
      )}
    </div>
  );
}

/** Ponto de entrada: renderiza a raiz, seja ela container ou escalar. */
export function RootEditor({ node }: { readonly node: JsonNode }) {
  if (node.kind === 'object') {
    return <ObjectEditor node={node} path={[]} />;
  }
  if (node.kind === 'array') {
    return <ArrayEditor node={node} path={[]} />;
  }
  return (
    <div className="kv-block">
      <p className="notice">
        A raiz deste parâmetro é um valor {kindLabel(node.kind)}, não um objeto. O editor de
        chave-valor não se aplica; use a aba JSON cru.
      </p>
    </div>
  );
}

export type { JsonNodeKind };
