import type { JsonNode } from '../../domain/json/JsonDocument.js';
import { appendEntry, appendItem } from '../../domain/json/editOperations.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import { useEditor } from './EditorContext.js';
import Icon from './Icon.js';
import TreeRow from './TreeRow.js';
import type { FlattenResult } from './treeRows.js';

/**
 * A grade. **Uma** `grid-template-columns`, declarada no CSS e aplicada por
 * `.tree-row` — cabeçalho, header de container e folha usam exatamente a mesma.
 *
 * É a mudança que conserta o bug: antes, cada nível de aninhamento abria um grid
 * novo dentro de uma largura já estreitada, e a coluna de valor era recalculada
 * a cada nível até sobrar ~30px. Agora a coluna de valor é medida uma vez,
 * contra a largura total, e profundidade é só `padding-left` na célula de chave.
 *
 * A região `aria-live` é única para a grade inteira. Uma por linha faria o leitor
 * de tela anunciar a reordenação do lugar errado.
 */

interface Props {
  readonly tree: FlattenResult;
  /** Nó no escopo atual, para saber o que os botões do rodapé adicionam. */
  readonly scopeNode: JsonNode | undefined;
  readonly scopePath: EditPath;
  readonly isSearching: boolean;
  readonly announcement: string;
  readonly dragOverKey: string | undefined;
}

export default function TreeGrid({
  tree,
  scopeNode,
  scopePath,
  isSearching,
  announcement,
  dragOverKey,
}: Props) {
  const editor = useEditor();
  const scopeIsArray = scopeNode?.kind === 'array';

  return (
    <div className="tree">
      <div className="tree-head" role="presentation">
        <span />
        <span>Campo</span>
        <span>Tipo</span>
        <span>Valor</span>
        <span />
      </div>

      {tree.rows.length === 0 && (
        <p className="tree-empty">
          {isSearching
            ? 'Nenhum caminho casa com a busca.'
            : scopeIsArray
              ? 'Lista vazia.'
              : 'Objeto vazio.'}
        </p>
      )}

      {tree.rows.map((row) => (
        <TreeRow key={row.id} row={row} isDragTarget={dragOverKey === row.key} />
      ))}

      {/*
        O rodapé adiciona ao escopo atual. Para um objeto aninhado visível na
        mesma grade, o `+` do header dele é o caminho — senão seria preciso
        entrar no escopo só para acrescentar um campo.
      */}
      {!isSearching && scopeNode !== undefined && (
        <div className="tree-foot">
          <button
            type="button"
            className="secondary"
            onClick={() =>
              editor.edit((document) =>
                scopeIsArray
                  ? appendItem(document, scopePath, 'string')
                  : appendEntry(document, scopePath, '', 'string'),
              )
            }
          >
            <Icon name="plus" size={13} /> {scopeIsArray ? 'Item' : 'Campo'}
          </button>

          <button
            type="button"
            className="secondary"
            onClick={() =>
              editor.edit((document) =>
                scopeIsArray
                  ? appendItem(document, scopePath, 'object')
                  : appendEntry(document, scopePath, '', 'object'),
              )
            }
          >
            <Icon name="plus" size={13} /> Objeto
          </button>
        </div>
      )}

      {/*
        `role="status"` com `aria-live="polite"`: anuncia a nova posição depois
        de reordenar por Alt+setas, sem interromper o que estiver sendo lido.
      */}
      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
