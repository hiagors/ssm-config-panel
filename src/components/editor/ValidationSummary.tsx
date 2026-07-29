import type { ValidationResult } from '../../application/validation/validateDocument.js';

/**
 * Resumo da validação.
 *
 * Erro bloqueia o save; aviso não. Nenhuma mensagem contém valor de campo —
 * só chave, caminho e números, que são estrutura e não segredo.
 */

interface Props {
  readonly result: ValidationResult;
}

export default function ValidationSummary({ result }: Props) {
  if (result.issues.length === 0) {
    return (
      <p className="validation ok">
        Sem problemas de validação. {result.sizeInBytes} de {result.sizeLimitInBytes} bytes.
      </p>
    );
  }

  return (
    <div className={`validation ${result.errorCount > 0 ? 'error' : 'warn'}`}>
      <p className="validation-head">
        {result.errorCount > 0
          ? `${result.errorCount} ${result.errorCount === 1 ? 'erro' : 'erros'}`
          : 'Nenhum erro'}
        {result.warningCount > 0 &&
          ` · ${result.warningCount} ${result.warningCount === 1 ? 'aviso' : 'avisos'}`}
        {result.errorCount > 0 && ' — o save fica bloqueado até resolver.'}
      </p>
      <ul>
        {result.issues.map((issue) => (
          <li key={`${issue.code}-${issue.label}-${issue.message}`} className={issue.severity}>
            <code>{issue.label}</code> {issue.message}
          </li>
        ))}
      </ul>
    </div>
  );
}
