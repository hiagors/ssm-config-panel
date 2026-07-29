import type { JsonParseError } from '../../domain/json/parseJsonDocument.js';

/**
 * Aba JSON cru, com sincronização bidirecional.
 *
 * Formulário → texto: o serializador emite verbatim o que não foi editado,
 * então abrir esta aba sem ter editado nada mostra o texto original intacto.
 *
 * Texto → formulário: reparseia a cada tecla. Enquanto estiver inválido, o
 * texto é a fonte da verdade, o formulário fica indisponível e o motivo
 * aparece com **linha e coluna, nunca o trecho** — a entrada pode ser um
 * `SecureString` decriptado.
 *
 * Também é a única aba disponível quando o valor guardado não é JSON.
 */

interface Props {
  readonly text: string;
  readonly onChange: (text: string) => void;
  readonly parseError: JsonParseError | undefined;
  /** `true` quando o parâmetro é `SecureString` e nada foi revelado. */
  readonly masked: boolean;
  readonly onRevealAll: () => void;
}

export default function RawJsonEditor({
  text,
  onChange,
  parseError,
  masked,
  onRevealAll,
}: Props) {
  if (masked) {
    return (
      <div className="raw-masked">
        <p className="notice">
          Este parâmetro é <code>SecureString</code>. O JSON cru mostra todos os valores de uma
          vez, então ele começa oculto.
        </p>
        <button type="button" onClick={onRevealAll}>
          Revelar e editar JSON cru
        </button>
      </div>
    );
  }

  return (
    <div>
      {parseError !== undefined && (
        <p className="notice error raw-error">
          {parseError.message} O formulário estruturado fica indisponível até o JSON ficar válido.
          Nada foi convertido nem corrigido automaticamente.
        </p>
      )}

      <textarea
        className={`raw-editor${parseError !== undefined ? ' invalid' : ''}`}
        value={text}
        onChange={(event) => onChange(event.target.value)}
        rows={20}
        aria-label="JSON cru"
        aria-invalid={parseError !== undefined || undefined}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        autoCorrect="off"
        data-1p-ignore=""
        data-lpignore="true"
      />
    </div>
  );
}
