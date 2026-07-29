import { useMemo } from 'react';
import type { GetParameterResult } from '../../application/GetParameterUseCase.js';
import { issuesByPath, validateDocument } from '../../application/validation/validateDocument.js';
import { EditorProvider } from './EditorContext.js';
import { RootEditor } from './NodeEditor.js';
import RawJsonEditor from './RawJsonEditor.js';
import ValidationSummary from './ValidationSummary.js';
import { useParameterDraft } from './useParameterDraft.js';

/**
 * Ilha de topo do editor.
 *
 * Fase 2a: edita e valida, sem nenhum caminho de gravação. O botão Salvar
 * existe desabilitado de propósito — o save só nasce na 2b, junto com o diff
 * e a proteção contra lost update, porque gravar sem as duas violaria
 * "nunca salvar por acidente".
 */

interface Props {
  readonly parameter: GetParameterResult;
}

export default function ParameterEditor({ parameter }: Props) {
  const draft = useParameterDraft(
    parameter.value,
    parameter.metadata.version,
    parameter.isSecret,
  );

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

  const nothingRevealed = parameter.isSecret && !state.revealAll && state.revealedPaths.size === 0;

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
            parseError={
              state.content.kind === 'rawInvalid' ? state.content.error : undefined
            }
            masked={nothingRevealed}
            onRevealAll={draft.toggleRevealAll}
          />
        )}
      </div>

      {validation !== undefined && <ValidationSummary result={validation} />}

      <footer className="editor-foot">
        <button type="button" className="secondary" disabled={!draft.isDirty} onClick={draft.discard}>
          Descartar alterações
        </button>

        <button
          type="button"
          disabled
          title="O save entra na Fase 2b, junto com o diff e a proteção contra lost update"
        >
          Salvar (Fase 2b)
        </button>
      </footer>

      <p className="muted foot-note">
        Fase 2a: edição e validação, sem gravação. O save vai exigir diff, confirmação explícita e
        recheque de versão contra alteração externa.
      </p>
    </section>
  );
}
