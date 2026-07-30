/**
 * Busca por caminho e controle de expansão.
 *
 * A busca aceita as **duas** notações: `db_connections.banking` e
 * `/db_connections/banking`, porque ponto, barra e colchete são normalizados
 * como o mesmo separador. Isso existe para um caso concreto: as mensagens de
 * validação e o diff usam barra, e colar um caminho de lá aqui precisa
 * funcionar — senão a notação dupla vira armadilha em vez de conveniência.
 *
 * O casamento é por segmento: cada termo tem de estar **dentro** de um segmento,
 * sem atravessar separador. `pool.min` casa `DATABASE.pool.min`; `db.min` não
 * casa `db.pool.min`, porque pularia um nível.
 */

interface Props {
  readonly query: string;
  readonly onQueryChange: (query: string) => void;
  readonly matchCount: number;
  readonly isSearching: boolean;
  readonly allExpanded: boolean;
  readonly onExpandAll: () => void;
  readonly onCollapseAll: () => void;
}

export default function TreeToolbar({
  query,
  onQueryChange,
  matchCount,
  isSearching,
  allExpanded,
  onExpandAll,
  onCollapseAll,
}: Props) {
  return (
    <div className="tree-toolbar">
      <div className="tree-search">
        <input
          type="text"
          className="search-input"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="filtrar por caminho: db_connections.banking"
          aria-label="Filtrar campos por caminho"
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
        />
        {isSearching && (
          <>
            <span className="search-count">
              {matchCount} {matchCount === 1 ? 'caminho' : 'caminhos'}
            </span>
            <button
              type="button"
              className="secondary search-clear"
              onClick={() => onQueryChange('')}
            >
              Limpar
            </button>
          </>
        )}
      </div>

      <button
        type="button"
        className="secondary"
        disabled={isSearching}
        title={isSearching ? 'A busca controla a expansão enquanto está ativa' : undefined}
        onClick={allExpanded ? onCollapseAll : onExpandAll}
      >
        {allExpanded ? 'Recolher' : 'Expandir'}
      </button>
    </div>
  );
}
