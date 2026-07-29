import { useMemo, useState } from 'react';
import type { GetParameterResult } from '../../application/GetParameterUseCase.js';
import type { ValidationIssue } from '../../application/validation/validateDocument.js';
import { issuesByPath, validateDocument } from '../../application/validation/validateDocument.js';
import { parseJsonDocument } from '../../domain/json/parseJsonDocument.js';
import { structuralDiff, threeWayDiff } from '../../domain/json/structuralDiff.js';
import ConflictView from './ConflictView.js';
import DiffView from './DiffView.js';
import { EditorProvider } from './EditorContext.js';
import { RootEditor } from './NodeEditor.js';
import RawJsonEditor from './RawJsonEditor.js';
import ValidationSummary from './ValidationSummary.js';
import { saveParameter } from './saveParameter.js';
import { useParameterDraft } from './useParameterDraft.js';

/**
 * Ilha de topo do editor.
 *
 * O caminho de gravação existe a partir da Fase 2b e tem duas barreiras
 * obrigatórias, nesta ordem: **diff com confirmação explícita** e **recheque de
 * versão no servidor**. Não há atalho — `salvar` sempre passa pela revisão, e o
 * servidor sempre relê antes de gravar.
 */

interface Props {
  readonly parameter: GetParameterResult;
  /** Profile em uso; vai em toda gravação, para a identidade nunca ser inferida. */
  readonly profileName?: string | undefined;
  /**
   * `true` no driver `aws`, onde a escrita ainda não está habilitada.
   *
   * O botão de revisar continua visível e explica o motivo, em vez de
   * desaparecer: some é pior, porque o usuário fica sem saber se é bug.
   */
  readonly readOnly?: boolean;
}

type SavePhase =
  | { readonly phase: 'editing' }
  /** Diff na tela, aguardando confirmação explícita. */
  | { readonly phase: 'reviewing' }
  | { readonly phase: 'saving' }
  | { readonly phase: 'saved'; readonly version: number }
  | {
      readonly phase: 'conflict';
      readonly currentValue: string;
      readonly currentVersion: number;
    }
  | { readonly phase: 'rejected'; readonly issues: readonly ValidationIssue[] }
  | { readonly phase: 'failed'; readonly message: string };

export default function ParameterEditor({
  parameter,
  profileName,
  readOnly = false,
}: Props) {
  const draft = useParameterDraft(
    parameter.value,
    parameter.metadata.version,
    parameter.isSecret,
  );

  const [save, setSave] = useState<SavePhase>({ phase: 'editing' });

  const { state } = draft;
  const document = state.content.kind === 'structured' ? state.content.document : undefined;

  const validation = useMemo(
    () =>
      document === undefined ? undefined : validateDocument(document, parameter.metadata.tier),
    [document, parameter.metadata.tier],
  );

  const issueIndex = useMemo(
    () => (validation === undefined ? new Map() : issuesByPath(validation)),
    [validation],
  );

  const changeSet = useMemo(() => {
    if (document === undefined || draft.baseDocument === undefined) {
      return undefined;
    }
    return structuralDiff(draft.baseDocument, document);
  }, [draft.baseDocument, document]);

  const conflictDiff = useMemo(() => {
    if (save.phase !== 'conflict' || document === undefined || draft.baseDocument === undefined) {
      return undefined;
    }
    const current = parseJsonDocument(save.currentValue);
    if (!current.ok) {
      return undefined;
    }
    return threeWayDiff(draft.baseDocument, current.document, document);
  }, [save, draft.baseDocument, document]);

  const canReview =
    !readOnly &&
    draft.isDirty &&
    document !== undefined &&
    validation?.canSave === true &&
    changeSet?.isEmpty === false;

  async function confirmSave(): Promise<void> {
    setSave({ phase: 'saving' });

    const result = await saveParameter(
      parameter.metadata.name,
      draft.currentText,
      state.base.version,
      profileName,
    );

    if (!result.ok) {
      setSave({ phase: 'failed', message: result.message });
      return;
    }

    switch (result.outcome.outcome) {
      case 'saved':
        // A base passa a ser o que acabou de ser gravado: o rascunho deixa de
        // estar pendente e a próxima edição parte da versão nova.
        draft.rebase(draft.currentText, result.outcome.version);
        setSave({ phase: 'saved', version: result.outcome.version });
        return;

      case 'conflict':
        setSave({
          phase: 'conflict',
          currentValue: result.outcome.currentValue,
          currentVersion: result.outcome.currentVersion,
        });
        return;

      case 'invalid':
        setSave({ phase: 'rejected', issues: result.outcome.issues });
        return;

      case 'notFound':
        setSave({
          phase: 'failed',
          message:
            `O parâmetro ${parameter.metadata.name} não existe mais no store. ` +
            `Nada foi criado — criar é um fluxo separado e explícito.`,
        });
        return;
    }
  }

  return (
    <section className="editor">
      <header className="editor-head">
        <h1 className="param-name">{parameter.metadata.name}</h1>

        <div className="badges">
          <span className="badge">
            type <strong>{parameter.metadata.type}</strong>
          </span>
          <span className="badge">
            tier <strong>{parameter.metadata.tier}</strong>
          </span>
          <span className="badge">
            versão <strong>{state.base.version}</strong>
          </span>
          {parameter.metadata.keyId !== undefined && (
            <span className="badge">
              keyId <strong>{parameter.metadata.keyId}</strong>
            </span>
          )}
          {validation !== undefined && (
            <span
              className="badge"
              style={
                validation.sizeInBytes > validation.sizeLimitInBytes
                  ? { color: 'var(--danger)' }
                  : undefined
              }
            >
              tamanho{' '}
              <strong>
                {validation.sizeInBytes} / {validation.sizeLimitInBytes} B
              </strong>
            </span>
          )}
          {draft.isDirty && <span className="badge dirty">rascunho não salvo</span>}
        </div>
      </header>

      {parameter.isSecret && (
        <div className="secret-bar">
          <span>
            <code>SecureString</code> — todos os valores entram mascarados, porque
            <code> Type</code> é do parâmetro inteiro e não das chaves.
          </span>
          <button type="button" className="secondary" onClick={draft.toggleRevealAll}>
            {state.revealAll ? 'Ocultar tudo' : 'Revelar tudo'}
          </button>
        </div>
      )}

      {save.phase === 'saved' && (
        <p className="notice success">
          Gravado. O parâmetro agora está na <strong>versão {save.version}</strong>.
        </p>
      )}

      {save.phase === 'failed' && <p className="notice error">{save.message}</p>}

      {save.phase === 'rejected' && (
        <div className="notice error">
          <p>
            <strong>O servidor recusou a gravação.</strong> A validação do cliente é conveniência;
            a que decide é a do servidor.
          </p>
          <ul>
            {save.issues.map((issue) => (
              <li key={`${issue.code}-${issue.label}`}>
                <code>{issue.label}</code> {issue.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {save.phase === 'conflict' && (
        <ConflictView
          parameterName={parameter.metadata.name}
          baseVersion={state.base.version}
          currentVersion={save.currentVersion}
          diff={
            conflictDiff ?? { changes: [], isMergeableWithoutConflict: true }
          }
          isSecret={parameter.isSecret}
          onCancel={() => setSave({ phase: 'editing' })}
          onRebaseOnCurrent={() => {
            draft.rebase(save.currentValue, save.currentVersion);
            setSave({ phase: 'editing' });
          }}
          onDiscardMine={() => {
            draft.reload(save.currentValue, save.currentVersion);
            setSave({ phase: 'editing' });
          }}
        />
      )}

      {save.phase === 'reviewing' && (
        <div className="panel review">
          <h2 className="review-title">Revisar antes de gravar</h2>

          {changeSet === undefined ? (
            <p className="notice">
              O valor carregado não é JSON, então não há diff estruturado. Compare o texto na aba
              JSON cru antes de confirmar.
            </p>
          ) : (
            <DiffView
              changeSet={changeSet}
              isSecret={parameter.isSecret}
              isRevealed={draft.isRevealed}
              onToggleReveal={draft.toggleRevealPath}
            />
          )}

          <div className="review-actions">
            <button
              type="button"
              className="secondary"
              onClick={() => setSave({ phase: 'editing' })}
            >
              Voltar a editar
            </button>
            <button type="button" onClick={() => void confirmSave()}>
              Confirmar gravação da versão {state.base.version} → {state.base.version + 1}
            </button>
          </div>

          <p className="muted review-note">
            O servidor relê o parâmetro antes de gravar e aborta se a versão tiver mudado. Alteração
            externa nunca é sobrescrita em silêncio.
          </p>
        </div>
      )}

      {save.phase !== 'reviewing' && save.phase !== 'conflict' && (
        <>
          <nav className="tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={state.tab === 'structured'}
              className={state.tab === 'structured' ? 'tab active' : 'tab'}
              disabled={!draft.canUseStructuredTab}
              title={
                draft.canUseStructuredTab
                  ? undefined
                  : 'Indisponível enquanto o JSON estiver inválido'
              }
              onClick={() => draft.selectTab('structured')}
            >
              Formulário
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={state.tab === 'raw'}
              className={state.tab === 'raw' ? 'tab active' : 'tab'}
              onClick={() => draft.selectTab('raw')}
            >
              JSON cru
            </button>
          </nav>

          <div className="panel editor-body">
            {state.tab === 'structured' && document !== undefined && (
              <EditorProvider
                value={{
                  edit: draft.edit,
                  isSecret: parameter.isSecret,
                  isRevealed: draft.isRevealed,
                  toggleRevealPath: draft.toggleRevealPath,
                  issuesByPath: issueIndex,
                }}
              >
                <RootEditor node={document.root} />
              </EditorProvider>
            )}

            {state.tab === 'raw' && (
              <RawJsonEditor
                text={draft.currentText}
                onChange={draft.setRaw}
                parseError={state.content.kind === 'rawInvalid' ? state.content.error : undefined}
                masked={parameter.isSecret && !state.revealAll && state.revealedPaths.size === 0}
                onRevealAll={draft.toggleRevealAll}
              />
            )}
          </div>

          {validation !== undefined && <ValidationSummary result={validation} />}

          <footer className="editor-foot">
            <button
              type="button"
              className="secondary"
              disabled={!draft.isDirty || save.phase === 'saving'}
              onClick={() => {
                draft.discard();
                setSave({ phase: 'editing' });
              }}
            >
              Descartar alterações
            </button>

            <button
              type="button"
              disabled={!canReview || save.phase === 'saving'}
              title={
                readOnly
                  ? 'A gravação no SSM real entra junto com o backup local'
                  : reviewButtonHint(draft.isDirty, validation?.canSave, changeSet?.isEmpty)
              }
              onClick={() => setSave({ phase: 'reviewing' })}
            >
              {save.phase === 'saving' ? 'Gravando…' : 'Revisar e salvar'}
            </button>
          </footer>

          {readOnly && (
            <p className="notice foot-notice">
              <strong>Somente leitura neste driver.</strong> Editar e validar funciona, mas gravar
              no SSM real só depois que o backup local existir — nenhuma escrita em conta de
              produção sem rede de proteção. Para exercitar o save, use{' '}
              <code>STORE_DRIVER=local</code>.
            </p>
          )}
        </>
      )}
    </section>
  );
}

/** Explica por que o botão está desabilitado, em vez de só ficar cinza. */
function reviewButtonHint(
  isDirty: boolean,
  canSave: boolean | undefined,
  diffIsEmpty: boolean | undefined,
): string | undefined {
  if (!isDirty || diffIsEmpty === true) {
    return 'Nada mudou em relação ao valor carregado';
  }
  if (canSave === false) {
    return 'Resolva os erros de validação primeiro';
  }
  if (canSave === undefined) {
    return 'O JSON precisa ser válido para gravar';
  }
  return undefined;
}
