import type { DragEvent } from 'react';
import type { JsonNode, JsonNodeKind } from '../../domain/json/JsonDocument.js';
import { kindLabel } from '../../domain/json/JsonDocument.js';
import { isValidNumberLexeme } from '../../domain/json/jsonNumber.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import {
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
import GripHandle from './GripHandle.js';
import Icon from './Icon.js';
import RowKebabMenu from './RowKebabMenu.js';
import TypeSelector from './TypeSelector.js';
import ValueInput from './ValueInput.js';
import type { TreeRow as Row } from './treeRows.js';

/**
 * Uma linha da grade, sempre com **as mesmas cinco células**.
 *
 * Header e folha divergem no conteúdo, nunca na contagem de células — é isso que
 * mantém as colunas alinhadas entre profundidades. Um `display: contents` ou uma
 * célula faltando quebraria o alinhamento justo nas linhas aninhadas, que é o
 * que a mudança inteira existe para consertar.
 *
 * A indentação vive **só** na célula de chave, como `padding-left`. O container
 * da linha nunca ganha padding por profundidade.
 */

interface Props {
  readonly row: Row;
  readonly isDragTarget: boolean;
}

/** Largura de um nível de indentação, casada com o CSS. */
const INDENT_STEP_PX = 16;

export default function TreeRow({ row, isDragTarget }: Props) {
  const editor = useEditor();
  const issues = editor.issuesByPath.get(row.key) ?? [];
  const hasError = issues.some((issue) => issue.severity === 'error');

  const className = [
    'tree-row',
    row.isContainer ? 'is-header' : 'is-leaf',
    hasError ? 'has-error' : '',
    isDragTarget ? 'is-drop-target' : '',
  ]
    .filter((part) => part !== '')
    .join(' ');

  function move(delta: number): boolean {
    const parentIndex = row.indexInParent + delta;

    if (parentIndex < 0 || parentIndex >= row.siblingCount) {
      return false;
    }

    editor.edit((document) =>
      row.isArrayItem ? moveItem(document, row.path, delta) : moveEntry(document, row.path, delta),
    );

    return true;
  }

  function remove(): void {
    editor.edit((document) =>
      row.isArrayItem ? removeItem(document, row.path) : removeEntry(document, row.path),
    );
  }

  function convert(kind: JsonNodeKind): void {
    editor.edit((document) => changeNodeKind(document, row.path, kind));
  }

  return (
    <div
      className={className}
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        if (editor.drag !== undefined) {
          event.preventDefault();
          editor.onDragOver(row.key);
        }
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        editor.onDrop(row.path);
      }}
    >
      {/* 1. calha do grip, fora da indentação */}
      <div className="tree-gutter">
        <GripHandle
          label={row.label}
          indexInParent={row.indexInParent}
          siblingCount={row.siblingCount}
          onMove={move}
          onDragStart={() => editor.onDragStart(row.path)}
          onDragEnd={editor.onDragEnd}
          onAnnounce={editor.announce}
        />
      </div>

      {/*
        2. chave — a única célula que conhece profundidade.
        A guia `border-left` só aparece a partir do primeiro nível: na raiz ela
        seria uma linha vertical solta, sem nada para guiar.
      */}
      <div
        className={`tree-key${row.depth > 0 ? ' is-indented' : ''}`}
        style={{ paddingLeft: `${row.depth * INDENT_STEP_PX}px` }}
      >
        {row.isContainer ? (
          <button
            type="button"
            className="tree-disclosure"
            aria-expanded={row.drillInOnly ? undefined : row.isExpanded}
            title={row.drillInOnly ? 'Entrar neste nível' : undefined}
            onClick={() =>
              row.drillInOnly ? editor.onDrillIn(row.path) : editor.onToggleExpanded(row.path)
            }
          >
            <Icon name="chevron" rotate={row.isExpanded ? 90 : 0} size={14} />
            <span className="tree-label">{row.label}</span>
            {row.drillInOnly && <span className="drill-hint">entrar</span>}
          </button>
        ) : row.isArrayItem ? (
          <span className="tree-label item-label">{row.label}</span>
        ) : (
          <input
            type="text"
            className={`key-input${hasError ? ' invalid' : ''}`}
            value={row.label}
            onChange={(event) =>
              editor.edit((document) => renameEntry(document, row.path, event.target.value))
            }
            aria-label={`Chave de ${row.dottedPath || row.label}`}
            placeholder="chave"
            autoComplete="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
          />
        )}
      </div>

      {/* 3. tipo — texto em header, seletor de escalares em folha */}
      <div className="tree-type">
        {row.isContainer ? (
          <span className="type-text">{kindLabel(row.kind)}</span>
        ) : (
          <TypeSelector
            kind={row.kind}
            ariaLabel={`Tipo de ${row.dottedPath || row.label}`}
            onChange={convert}
          />
        )}
      </div>

      {/* 4. valor — badge de contagem em header, input em folha */}
      <div className="tree-value">
        {row.isContainer ? (
          <span className="child-badge">
            {row.childCount} {childUnit(row.node, row.childCount)}
          </span>
        ) : (
          <ScalarValue row={row} />
        )}
      </div>

      {/* 5. ação — dois slots: (+ ou X) e kebab */}
      <div className="tree-actions">
        {row.isContainer ? (
          <button
            type="button"
            className="row-action"
            aria-label={`Adicionar campo em ${row.label}`}
            onClick={() => editor.onAddChild(row.path, row.kind)}
          >
            <Icon name="plus" size={14} />
          </button>
        ) : (
          <button
            type="button"
            className="row-action danger"
            aria-label={`Remover ${row.label}`}
            onClick={remove}
          >
            <Icon name="x" size={14} />
          </button>
        )}

        <RowKebabMenu
          node={row.node}
          label={row.label}
          dottedPath={row.dottedPath}
          onConvert={convert}
          onRemove={remove}
        />
      </div>

      {issues.length > 0 && (
        <ul className="tree-issues">
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

/** Célula de valor de escalar. Reusa o `ValueInput` e o mascaramento existentes. */
function ScalarValue({ row }: { readonly row: Row }) {
  const editor = useEditor();
  const revealed = editor.isRevealed(row.path);
  const masked = editor.isSecret && !revealed;
  const label = row.dottedPath || row.label;

  return (
    <div className="value-slot">
      {row.node.kind === 'string' && (
        <ValueInput
          value={row.node.value}
          masked={masked}
          ariaLabel={`Valor de ${label}`}
          onChange={(value) => editor.edit((document) => setStringValue(document, row.path, value))}
        />
      )}

      {row.node.kind === 'number' && (
        <ValueInput
          value={row.node.raw}
          numeric
          masked={masked}
          invalid={!isValidNumberLexeme(row.node.raw)}
          ariaLabel={`Valor de ${label}`}
          onChange={(raw) => editor.edit((document) => setNumberLexeme(document, row.path, raw))}
        />
      )}

      {row.node.kind === 'boolean' && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={masked ? false : row.node.value}
            disabled={masked}
            aria-label={`Valor de ${label}`}
            onChange={(event) =>
              editor.edit((document) =>
                setBooleanValue(document, row.path, event.target.checked),
              )
            }
          />
          <span>{masked ? '•••' : row.node.value ? 'true' : 'false'}</span>
        </label>
      )}

      {row.node.kind === 'null' && (
        <ValueInput
          value="null"
          disabled
          ariaLabel={`Valor de ${label} (null)`}
          onChange={() => undefined}
        />
      )}

      {editor.isSecret && row.node.kind !== 'null' && (
        <button
          type="button"
          className="row-action reveal"
          aria-label={`${revealed ? 'Ocultar' : 'Revelar'} valor de ${label}`}
          onClick={() => editor.toggleRevealPath(row.path)}
        >
          <Icon name="eye" size={14} />
        </button>
      )}
    </div>
  );
}

function childUnit(node: JsonNode, count: number): string {
  if (node.kind === 'array') {
    return count === 1 ? 'item' : 'itens';
  }
  return count === 1 ? 'campo' : 'campos';
}

export type { EditPath };
