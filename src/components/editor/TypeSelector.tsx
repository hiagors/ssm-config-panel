import type { ChangeEvent } from 'react';
import type { JsonNodeKind } from '../../domain/json/JsonDocument.js';
import { SELECTABLE_KINDS, kindLabel } from '../../domain/json/JsonDocument.js';

/**
 * Seletor de tipo do campo.
 *
 * O tipo é escolhido aqui, nunca inferido do conteúdo. É o que mantém
 * `{"a": null}` e `{"a": ""}` como coisas diferentes: um campo de texto vazio
 * é `string`, e `null` só acontece se o usuário selecionar `null`.
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
      {SELECTABLE_KINDS.map((candidate) => (
        <option key={candidate} value={candidate}>
          {kindLabel(candidate)}
        </option>
      ))}
    </select>
  );
}
