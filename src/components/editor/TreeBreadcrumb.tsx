import type { EditPath } from '../../domain/json/jsonPath.js';
import Icon from './Icon.js';

/**
 * Caminho do escopo atual: `raiz › db_connections › banking`.
 *
 * Notação com pontos na árvore, e por isso segmentos separados aqui. O diff e as
 * mensagens de validação seguem com barra (`/DATABASE/pool/min`) — as duas
 * convivem de propósito, e o campo de busca aceita ambas para que um caminho
 * copiado de uma mensagem de validação encontre resultado.
 *
 * É uma `<nav>` com lista: cada segmento é um `<button>`, então navegar e voltar
 * funcionam por Tab e Enter. O último não é botão — já é onde se está.
 */

interface Props {
  readonly segments: readonly string[];
  readonly scopePath: EditPath;
  readonly onNavigate: (path: EditPath) => void;
}

export default function TreeBreadcrumb({ segments, scopePath, onNavigate }: Props) {
  if (segments.length === 0) {
    return null;
  }

  return (
    <nav className="breadcrumb" aria-label="Caminho do escopo">
      <ol>
        <li>
          <button type="button" className="crumb" onClick={() => onNavigate([])}>
            raiz
          </button>
        </li>

        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          // Prefixo do escopo até este segmento, para voltar a qualquer nível.
          const target = scopePath.slice(0, index + 1);

          return (
            <li key={`${index}-${segment}`}>
              <Icon name="chevron" size={12} />
              {isLast ? (
                <span className="crumb current" aria-current="location">
                  {segment}
                </span>
              ) : (
                <button type="button" className="crumb" onClick={() => onNavigate(target)}>
                  {segment}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
