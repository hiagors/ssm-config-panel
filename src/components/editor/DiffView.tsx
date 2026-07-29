import type { Change, ChangeSet, ValueSnapshot } from '../../domain/json/structuralDiff.js';
import type { EditPath } from '../../domain/json/jsonPath.js';

/**
 * Diff por caminho.
 *
 * Em `SecureString`, mostra **quais chaves** mudaram sem exibir os valores,
 * respeitando a revelação escolhida durante a edição. Isso é possível porque o
 * diff é estrutural: chave e valor são campos separados. Num diff textual o
 * valor está no meio da linha e não há como omitir um sem omitir o outro.
 *
 * A máscara é ausência de dado, não CSS: o texto do valor não entra no DOM
 * enquanto o caminho não estiver revelado.
 */

const MASK = '••••••••';

interface Props {
  readonly changeSet: ChangeSet;
  readonly isSecret: boolean;
  readonly isRevealed: (path: EditPath) => boolean;
  readonly onToggleReveal: (path: EditPath) => void;
}

export default function DiffView({ changeSet, isSecret, isRevealed, onToggleReveal }: Props) {
  if (changeSet.isEmpty) {
    return (
      <p className="diff-empty">
        Nenhuma alteração. O valor serializa exatamente igual ao que foi carregado.
      </p>
    );
  }

  if (changeSet.isFormattingOnly) {
    // Nenhuma chave ou valor mudou, mas o texto a gravar é outro. Acontece ao
    // reindentar ou minificar na aba crua. Vale gravar; só precisa ficar claro
    // que a lista vazia não é bug.
    return (
      <p className="notice diff-formatting">
        <strong>Só a formatação mudou.</strong> Nenhuma chave, valor ou ordem foi alterada — mas o
        texto que será gravado é diferente do carregado (espaçamento ou indentação). Compare na aba
        JSON cru se quiser conferir.
      </p>
    );
  }

  return (
    <div className="diff">
      <p className="diff-summary">{summarize(changeSet)}</p>

      <ul className="diff-list">
        {changeSet.changes.map((change) => (
          <ChangeRow
            key={`${change.kind}-${change.label}-${change.path.join('.')}`}
            change={change}
            masked={isSecret && !isRevealed(change.path)}
            isSecret={isSecret}
            onToggleReveal={() => onToggleReveal(change.path)}
          />
        ))}
      </ul>
    </div>
  );
}

function ChangeRow({
  change,
  masked,
  isSecret,
  onToggleReveal,
}: {
  readonly change: Change;
  readonly masked: boolean;
  readonly isSecret: boolean;
  readonly onToggleReveal: () => void;
}) {
  return (
    <li className={`diff-row ${change.kind}`}>
      <div className="diff-head">
        <span className={`diff-tag ${change.kind}`}>{tagLabel(change.kind)}</span>
        <code className="diff-path">{change.label}</code>
        {isSecret && change.kind !== 'moved' && (
          <button
            type="button"
            className="icon reveal"
            aria-label={`${masked ? 'Revelar' : 'Ocultar'} valores de ${change.label}`}
            onClick={onToggleReveal}
          >
            {masked ? '👁' : '🙈'}
          </button>
        )}
      </div>

      {change.kind === 'moved' ? (
        <p className="diff-moved">
          posição {change.fromPosition} → {change.toPosition}
        </p>
      ) : (
        <div className="diff-values">
          {change.before !== undefined && (
            <SnapshotLine sign="−" snapshot={change.before} masked={masked} />
          )}
          {change.after !== undefined && (
            <SnapshotLine sign="+" snapshot={change.after} masked={masked} />
          )}
        </div>
      )}
    </li>
  );
}

function SnapshotLine({
  sign,
  snapshot,
  masked,
}: {
  readonly sign: '−' | '+';
  readonly snapshot: ValueSnapshot;
  readonly masked: boolean;
}) {
  // Container é sempre resumo ("objeto com 3 campos"), nunca conteúdo, então
  // não carrega valor e pode aparecer mesmo mascarado.
  const showText = snapshot.isContainer || !masked;

  return (
    <p className={`diff-value ${sign === '+' ? 'after' : 'before'}`}>
      <span className="diff-sign">{sign}</span>
      <span className="diff-kind">{snapshot.nodeKind}</span>
      <span className="diff-text">{showText ? snapshot.text : MASK}</span>
    </p>
  );
}

function tagLabel(kind: Change['kind']): string {
  switch (kind) {
    case 'added':
      return 'adicionado';
    case 'removed':
      return 'removido';
    case 'changed':
      return 'alterado';
    case 'moved':
      return 'movido';
  }
}

function summarize(changeSet: ChangeSet): string {
  const counts = new Map<Change['kind'], number>();

  for (const change of changeSet.changes) {
    counts.set(change.kind, (counts.get(change.kind) ?? 0) + 1);
  }

  const parts: string[] = [];
  for (const kind of ['added', 'removed', 'changed', 'moved'] as const) {
    const count = counts.get(kind);
    if (count !== undefined) {
      parts.push(`${count} ${tagLabel(kind)}${count === 1 ? '' : 's'}`);
    }
  }

  return parts.join(' · ');
}

export { MASK as DIFF_MASK };
