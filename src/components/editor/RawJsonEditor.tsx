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
  /**
   * Texto formatado para leitura, quando o toggle está ligado.
   *
   * `undefined` desliga o toggle — ou porque o JSON está inválido, ou porque
   * formatar não mudaria nada.
   */
  readonly prettyText: string | undefined;
  readonly isPretty: boolean;
  readonly onTogglePretty: () => void;
}

export default function RawJsonEditor({
  text,
  onChange,
  parseError,
  masked,
  onRevealAll,
  prettyText,
  isPretty,
  onTogglePretty,
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

  const showingPretty = isPretty && prettyText !== undefined;

  return (
    <div>
      {parseError !== undefined && (
        <p className="notice error raw-error">
          {parseError.message} O formulário estruturado fica indisponível até o JSON ficar válido.
          Nada foi convertido nem corrigido automaticamente.
        </p>
      )}

      {prettyText !== undefined && (
        <div className="raw-toolbar">
          <label className="toggle">
            <input type="checkbox" checked={isPretty} onChange={onTogglePretty} />
            <span>Formatar para leitura</span>
          </label>
          {showingPretty && (
            <span className="muted raw-hint">
              Só visualização. O texto gravado continua sendo o original — ligar isto e salvar não
              muda nada.
            </span>
          )}
        </div>
      )}

      {showingPretty ? (
        // Somente-leitura de propósito: editar o texto formatado e devolvê-lo ao
        // documento reformataria o parâmetro inteiro num save sem edição.
        <textarea
          className="raw-editor is-pretty"
          value={prettyText}
          readOnly
          rows={20}
          aria-label="JSON formatado para leitura"
          spellCheck={false}
        />
      ) : (
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
      )}
    </div>
  );
}
