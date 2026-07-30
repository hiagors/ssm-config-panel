import type { ChangeEvent } from 'react';
import type { JsonNodeKind } from '../../domain/json/JsonDocument.js';
import { SCALAR_KINDS, kindLabel } from '../../domain/json/JsonDocument.js';

/**
 * Seletor de tipo do campo. **Só escalares.**
 *
 * O tipo é escolhido aqui, nunca inferido do conteúdo. É o que mantém
 * `{"a": null}` e `{"a": ""}` como coisas diferentes: um campo de texto vazio
 * é `string`, e `null` só acontece se o usuário selecionar `null`.
 *
 * Converter para `objeto` ou `lista` **saiu** deste seletor e virou ação do menu
 * kebab. O motivo é assimetria de consequência: entre escalares a conversão
 * preserva o texto bruto e a validação acusa o que ficou inválido — `"abc"` para
 * número continua `"abc"`, marcado como inválido. Para container não há como
 * preservar, e um clique errado num `<select>` é fácil demais para uma ação que
 * descarta conteúdo.
 */

interface Props {
  readonly kind: JsonNodeKind;
  readonly onChange: (kind: JsonNodeKind) => void;
  readonly ariaLabel: string;
  readonly disabled?: boolean;
}

export default function TypeSelector({ kind, onChange, ariaLabel, disabled = false }: Props) {
  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange(event.target.value as JsonNodeKind);
  };

  return (
    <select
      className="type-selector"
      value={kind}
      onChange={handleChange}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {SCALAR_KINDS.map((candidate) => (
        <option key={candidate} value={candidate}>
          {kindLabel(candidate)}
        </option>
      ))}
    </select>
  );
}
