import { useState } from 'react';
import type { GetParameterResult } from '../application/GetParameterUseCase.js';

/**
 * Ilha React da Fase 1: visualização.
 *
 * Mostra os metadados, o tamanho contra o limite do tier e o valor cru.
 * `SecureString` chega mascarado, com botão explícito de revelar — o valor
 * já está no payload da página por decisão do spec, mas não aparece na tela
 * até o usuário pedir.
 *
 * O editor estruturado de chave-valor é a Fase 2. Aqui não existe nenhum
 * caminho de gravação, de propósito: gravar sem diff violaria o critério de
 * "nunca salvar por acidente".
 */

interface Props {
  parameter: GetParameterResult;
}

export default function ParameterViewer({ parameter }: Props) {
  const [revealed, setRevealed] = useState(!parameter.isSecret);

  const { metadata, isValidJson, jsonError, sizeInBytes, sizeLimitInBytes } = parameter;
  const overLimit = sizeInBytes > sizeLimitInBytes;

  return (
    <section>
      <h1 style={{ fontFamily: 'var(--mono)', fontSize: '1.05rem', wordBreak: 'break-all' }}>
        {metadata.name}
      </h1>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', margin: '0.75rem 0 1.25rem' }}>
        <span className="badge">
          type <strong>{metadata.type}</strong>
        </span>
        <span className="badge">
          tier <strong>{metadata.tier}</strong>
        </span>
        <span className="badge">
          versão <strong>{metadata.version}</strong>
        </span>
        {metadata.keyId !== undefined && (
          <span className="badge">
            keyId <strong>{metadata.keyId}</strong>
          </span>
        )}
        <span className="badge" style={overLimit ? { color: 'var(--danger)' } : undefined}>
          tamanho{' '}
          <strong>
            {sizeInBytes} / {sizeLimitInBytes} B
          </strong>
        </span>
      </div>

      {overLimit && (
        <p className="notice error">
          O valor tem {sizeInBytes} bytes e excede o limite de {sizeLimitInBytes} bytes do tier{' '}
          {metadata.tier}. O SSM vai rejeitar a gravação.
        </p>
      )}

      {!isValidJson && (
        <p className="notice">
          Este valor não é JSON válido{jsonError ? ` — ${jsonError}` : '.'} Na Fase 2 ele cai no
          editor de texto cru; nada é convertido automaticamente.
        </p>
      )}

      <div className="panel">
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '0.7rem',
          }}
        >
          <label style={{ margin: 0 }}>
            Valor {isValidJson ? '(JSON válido)' : '(texto cru)'}
          </label>
          {parameter.isSecret && (
            <button
              type="button"
              className="secondary"
              onClick={() => setRevealed((current) => !current)}
            >
              {revealed ? 'Ocultar' : 'Revelar'}
            </button>
          )}
        </div>

        {revealed ? (
          <pre
            style={{
              margin: 0,
              padding: '0.8rem',
              background: '#0c0e13',
              border: '1px solid var(--border)',
              borderRadius: '6px',
              overflowX: 'auto',
              whiteSpace: 'pre',
            }}
          >
            {parameter.value}
          </pre>
        ) : (
          <p className="muted" style={{ margin: 0, fontFamily: 'var(--mono)', fontSize: '13px' }}>
            {maskedPlaceholder(sizeInBytes)}
          </p>
        )}
      </div>

      <p className="muted" style={{ fontSize: '12px', marginTop: '1rem' }}>
        Fase 1 é somente leitura. Edição, validação e diff entram na Fase 2.
      </p>
    </section>
  );
}

/** Placeholder que indica presença e ordem de grandeza, não o conteúdo. */
function maskedPlaceholder(sizeInBytes: number): string {
  return `${'•'.repeat(24)}  (SecureString mascarado, ${sizeInBytes} bytes)`;
}
