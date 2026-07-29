import type { ThreeWayChange, ThreeWayDiff } from '../../domain/json/structuralDiff.js';

/**
 * Alteração externa detectada: diff de três vias.
 *
 * A gravação **já foi abortada** quando esta tela aparece. Nada foi
 * sobrescrito, e o rascunho continua intacto no estado do React.
 *
 * As três colunas são base carregada / versão atual no store / minha edição,
 * classificadas por lado. Sem essa classificação o usuário só saberia que
 * "algo mudou" e teria de comparar dois JSON à mão:
 *
 * - `mine` — só eu mudei; regravar preserva a intenção de todos.
 * - `theirs` — só a outra pessoa mudou; regravar apagaria o trabalho dela.
 * - `both` — conflito de verdade no mesmo caminho.
 */

const MASK = '••••••••';

interface Props {
  readonly parameterName: string;
  readonly baseVersion: number;
  readonly currentVersion: number;
  readonly diff: ThreeWayDiff;
  readonly isSecret: boolean;
  readonly onDiscardMine: () => void;
  readonly onRebaseOnCurrent: () => void;
  readonly onCancel: () => void;
}

export default function ConflictView({
  parameterName,
  baseVersion,
  currentVersion,
  diff,
  isSecret,
  onDiscardMine,
  onRebaseOnCurrent,
  onCancel,
}: Props) {
  const conflicting = diff.changes.filter((change) => change.side === 'both');

  return (
    <div className="conflict">
      <p className="notice error">
        <strong>Nada foi gravado.</strong> O parâmetro <code>{parameterName}</code> está na versão{' '}
        {currentVersion}, mas a sua edição partiu da versão {baseVersion}. Alguém gravou nesse
        intervalo.
      </p>

      <p className="muted conflict-hint">
        {diff.isMergeableWithoutConflict
          ? 'As alterações estão em caminhos diferentes, então não há conflito real — mas a decisão é sua.'
          : `${conflicting.length} ${
              conflicting.length === 1 ? 'caminho foi alterado' : 'caminhos foram alterados'
            } pelos dois lados.`}
      </p>

      <table className="three-way">
        <thead>
          <tr>
            <th>caminho</th>
            <th>base (v{baseVersion})</th>
            <th>no store agora (v{currentVersion})</th>
            <th>minha edição</th>
          </tr>
        </thead>
        <tbody>
          {diff.changes.map((change) => (
            <ConflictRow key={change.label} change={change} isSecret={isSecret} />
          ))}
        </tbody>
      </table>

      <div className="conflict-actions">
        <button type="button" className="secondary" onClick={onCancel}>
          Continuar editando
        </button>
        <button type="button" className="secondary" onClick={onRebaseOnCurrent}>
          Rebasear na versão atual
        </button>
        <button type="button" className="secondary danger-action" onClick={onDiscardMine}>
          Descartar minha edição e recarregar
        </button>
      </div>

      <p className="muted conflict-note">
        <strong>Rebasear</strong> adota a versão atual do store como nova base e reaplica o texto
        que você editou por cima — a versão passa a ser {currentVersion} e o save volta a ser
        possível. Releia o diff antes de confirmar: se a outra pessoa mudou um caminho que você
        também mudou, o seu texto vence.
      </p>
    </div>
  );
}

function ConflictRow({
  change,
  isSecret,
}: {
  readonly change: ThreeWayChange;
  readonly isSecret: boolean;
}) {
  return (
    <tr className={`three-way-row ${change.side}`}>
      <td>
        <code>{change.label}</code>
        <span className={`side-tag ${change.side}`}>{sideLabel(change.side)}</span>
      </td>
      <td>{cell(change.base, isSecret)}</td>
      <td>{cell(change.current, isSecret)}</td>
      <td>{cell(change.mine, isSecret)}</td>
    </tr>
  );
}

/**
 * Célula de valor.
 *
 * Em `SecureString` o conflito mostra só quais caminhos divergiram, nunca o
 * conteúdo: aqui não há botão de revelar de propósito. Esta tela aparece em
 * momento de decisão apressada, e revelar segredo de três versões ao mesmo
 * tempo é o oposto do critério de compartilhar tela com segurança. Para ver o
 * conteúdo, volte a editar e revele campo por campo.
 */
function cell(snapshot: ThreeWayChange['base'], isSecret: boolean) {
  if (snapshot === undefined) {
    return <span className="muted">—</span>;
  }

  const text = isSecret && !snapshot.isContainer ? MASK : snapshot.text;

  return (
    <>
      <span className="diff-kind">{snapshot.nodeKind}</span> <span className="diff-text">{text}</span>
    </>
  );
}

function sideLabel(side: ThreeWayChange['side']): string {
  switch (side) {
    case 'mine':
      return 'só eu';
    case 'theirs':
      return 'só o outro';
    case 'both':
      return 'conflito';
  }
}

export { MASK as CONFLICT_MASK };
