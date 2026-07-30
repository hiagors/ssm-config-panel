import { useMemo, useState } from 'react';
import type { GetParameterResult } from '../../application/GetParameterUseCase.js';
import type { ValidationIssue } from '../../application/validation/validateDocument.js';
import { issuesByPath, validateDocument } from '../../application/validation/validateDocument.js';
import { appendEntry, appendItem, moveEntry, moveItem } from '../../domain/json/editOperations.js';
import { parseJsonDocument } from '../../domain/json/parseJsonDocument.js';
import { prettyPrintDocument } from '../../domain/json/prettyPrint.js';
import { structuralDiff, threeWayDiff } from '../../domain/json/structuralDiff.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import { pathKey } from '../../domain/json/jsonPath.js';
import ConflictView from './ConflictView.js';
import DiffView from './DiffView.js';
import { EditorProvider } from './EditorContext.js';
import RawJsonEditor from './RawJsonEditor.js';
import SessionExpiredBanner from './SessionExpiredBanner.js';
import TreeBreadcrumb from './TreeBreadcrumb.js';
import TreeGrid from './TreeGrid.js';
import TreeToolbar from './TreeToolbar.js';
import ValidationSummary from './ValidationSummary.js';
import { allContainerKeys } from './treeRows.js';
import { saveParameter } from './saveParameter.js';
import { useParameterDraft } from './useParameterDraft.js';
import { useTreeView } from './useTreeView.js';
import { useUnsavedChangesWarning } from './useUnsavedChangesWarning.js';

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
  | { readonly phase: 'failed'; readonly message: string }
  /** Token do SSO venceu. Banner não-bloqueante, rascunho intacto. */
  | { readonly phase: 'sessionExpired' };

export default function ParameterEditor({ parameter, profileName }: Props) {
  const draft = useParameterDraft(
    parameter.value,
    parameter.metadata.version,
    parameter.isSecret,
  );

  const [save, setSave] = useState<SavePhase>({ phase: 'editing' });
  const [isPretty, setIsPretty] = useState(false);

  // Fechar, recarregar ou voltar para a tela inicial com rascunho pendente pede
  // confirmação. A volta à tela inicial é onde se troca de profile.
  useUnsavedChangesWarning(draft.isDirty);

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

  const view = useTreeView(document);

  /**
   * Texto formatado da aba crua.
   *
   * Derivado do documento a cada render e jogado fora: **não** entra no
   * rascunho. Formatar de verdade marcaria todo nó como `dirty`, destruiria a
   * reemissão verbatim e faria um save sem edição reescrever o parâmetro
   * inteiro — além de encher o diff.
   *
   * `undefined` quando não há documento, ou quando formatar não mudaria nada:
   * oferecer um toggle sem efeito visível é ruído.
   */
  const prettyText = useMemo(() => {
    if (document === undefined) {
      return undefined;
    }

    const formatted = prettyPrintDocument(document);

    return formatted === draft.currentText ? undefined : formatted;
  }, [document, draft.currentText]);

  /**
   * Solta a linha arrastada sobre outra.
   *
   * Só reordena entre **irmãos**: `moveEntry` e `moveItem` operam dentro de um
   * container, e mover entre pais diferentes seria remover e inserir — outra
   * operação, com outra semântica de diff. Soltar fora do pai é ignorado em
   * silêncio, que é o comportamento menos surpreendente.
   */
  function handleDrop(toPath: EditPath): void {
    const from = view.drag?.fromPath;
    view.endDrag();

    if (from === undefined || from.length !== toPath.length || from.length === 0) {
      return;
    }

    const sameParent = from.slice(0, -1).every((index, position) => index === toPath[position]);

    if (!sameParent) {
      return;
    }

    const fromIndex = from[from.length - 1] as number;
    const toIndex = toPath[toPath.length - 1] as number;
    const delta = toIndex - fromIndex;

    if (delta === 0) {
      return;
    }

    const movedRow = view.tree.rows.find((row) => pathKey(row.path) === pathKey(from));

    draft.edit((current) =>
      movedRow?.isArrayItem
        ? moveItem(current, from, delta)
        : moveEntry(current, from, delta),
    );

    view.announce(
      `${movedRow?.label ?? 'campo'} movido para a posição ${toIndex + 1} de ${
        movedRow?.siblingCount ?? toIndex + 1
      }.`,
    );
  }

  const expandableKeys =
    document === undefined ? [] : allContainerKeys(document, view.scopePath);
  const allExpanded =
    expandableKeys.length > 0 && expandableKeys.every((key) => view.tree.rows.some((row) => row.key === key && row.isExpanded));

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
      // Expiração de token é estado, não erro: banner e reautenticação sem
      // recarregar, com o rascunho onde está.
      setSave(
        result.code === 'PROFILE_NOT_AUTHENTICATED'
          ? { phase: 'sessionExpired' }
          : { phase: 'failed', message: result.message },
      );
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

      {save.phase === 'sessionExpired' && (
        <SessionExpiredBanner
          profileName={profileName}
          onReauthenticated={() => setSave({ phase: 'editing' })}
        />
      )}

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
                  onToggleExpanded: view.toggleExpanded,
                  onDrillIn: view.drillInto,
                  onAddChild: (path, containerKind) =>
                    draft.edit((current) =>
                      containerKind === 'array'
                        ? appendItem(current, path, 'string')
                        : appendEntry(current, path, '', 'string'),
                    ),
                  announce: view.announce,
                  drag: view.drag,
                  onDragStart: view.beginDrag,
                  onDragOver: view.dragOver,
                  onDrop: handleDrop,
                  onDragEnd: view.endDrag,
                }}
              >
                <TreeToolbar
                  query={view.searchQuery}
                  onQueryChange={view.setSearchQuery}
                  matchCount={view.tree.matchCount}
                  isSearching={view.isSearching}
                  allExpanded={allExpanded}
                  onExpandAll={view.expandAll}
                  onCollapseAll={view.collapseAll}
                />

                <TreeBreadcrumb
                  segments={view.tree.scopeSegments}
                  scopePath={view.scopePath}
                  onNavigate={view.goToScope}
                />

                <TreeGrid
                  tree={view.tree}
                  scopeNode={view.tree.scopeNode}
                  scopePath={view.scopePath}
                  isSearching={view.isSearching}
                  announcement={view.announcement}
                  dragOverKey={view.drag?.overKey}
                />
              </EditorProvider>
            )}

            {state.tab === 'raw' && (
              <RawJsonEditor
                text={draft.currentText}
                onChange={draft.setRaw}
                parseError={state.content.kind === 'rawInvalid' ? state.content.error : undefined}
                masked={parameter.isSecret && !state.revealAll && state.revealedPaths.size === 0}
                onRevealAll={draft.toggleRevealAll}
                prettyText={prettyText}
                isPretty={isPretty}
                onTogglePretty={() => setIsPretty((current) => !current)}
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
              title={reviewButtonHint(draft.isDirty, validation?.canSave, changeSet?.isEmpty)}
              onClick={() => setSave({ phase: 'reviewing' })}
            >
              {save.phase === 'saving' ? 'Gravando…' : 'Revisar e salvar'}
            </button>
          </footer>

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
