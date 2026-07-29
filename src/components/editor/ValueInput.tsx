import type { ChangeEvent } from 'react';

/**
 * O **único** componente de input de valor do editor.
 *
 * Ser único é o mecanismo. Duas regras do spec dependem de estarem em todo
 * input de valor, e nenhuma das duas sobrevive como disciplina:
 *
 * 1. Gerenciador de senha não deve tocar nestes campos. Daí
 *    `autocomplete="off"` + `data-1p-ignore` (1Password) + `data-lpignore`
 *    (LastPass). Um campo que escapasse disso ofereceria "salvar senha" para
 *    um valor de parâmetro.
 * 2. `SecureString` mascara **todos** os valores. Máscara aqui significa que
 *    o valor real **não entra no DOM**: o input mostra pontos e fica
 *    somente-leitura até o usuário revelar. Não é CSS, é ausência do dado.
 *
 * Nunca use `type="password"` para mascarar: é exatamente o que faz
 * gerenciador de senha se oferecer, contrariando a regra 1.
 *
 * Também não usamos `type="number"`. O navegador normaliza e às vezes
 * esvazia `input.value` no meio da digitação, o que destruiria o lexema —
 * `30.0` viraria `30` e `9007199254740993` poderia perder precisão. Número é
 * `type="text"` com `inputMode="decimal"`, e a validação é a nossa.
 */

const MASK = '••••••••••••';

interface Props {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly ariaLabel: string;
  /** `true` para número: muda o teclado no mobile, não muda o tratamento. */
  readonly numeric?: boolean;
  /** `true` quando o valor está mascarado e não deve entrar no DOM. */
  readonly masked?: boolean;
  readonly invalid?: boolean;
  readonly disabled?: boolean;
  readonly placeholder?: string;
}

export default function ValueInput({
  value,
  onChange,
  ariaLabel,
  numeric = false,
  masked = false,
  invalid = false,
  disabled = false,
  placeholder,
}: Props) {
  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange(event.target.value);
  };

  return (
    <input
      // Sempre texto. Ver o comentário do arquivo sobre type="number".
      type="text"
      className={`value-input${invalid ? ' invalid' : ''}${masked ? ' masked' : ''}`}
      // Mascarado: o valor real não é renderizado.
      value={masked ? MASK : value}
      onChange={handleChange}
      readOnly={masked}
      disabled={disabled}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      placeholder={placeholder}
      inputMode={numeric ? 'decimal' : undefined}
      // ── as três regras que precisam estar em todo input de valor ──
      autoComplete="off"
      data-1p-ignore=""
      data-lpignore="true"
      // Corretor de texto e capitalização automática também não têm o que
      // fazer em valor de configuração.
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
    />
  );
}

export { MASK as MASKED_PLACEHOLDER };
