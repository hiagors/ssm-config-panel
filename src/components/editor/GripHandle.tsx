import type { DragEvent, KeyboardEvent } from 'react';
import Icon from './Icon.js';

/**
 * Alça de reordenação, na calha fixa à esquerda da grade.
 *
 * Fica **fora da indentação**, na primeira coluna do grid, então a área de
 * agarrar está sempre no mesmo x independente da profundidade. Dentro da célula
 * de chave ela deslizaria com o `padding-left` e o alvo mudaria de lugar a cada
 * nível.
 *
 * É um `<button>`, não uma `<div draggable>`, por dois motivos que andam juntos:
 * arrastar não funciona por teclado, e sumir a alça no `:hover` deixaria quem
 * navega por teclado sem nenhuma pista de que a linha é reordenável. Daí
 * `Alt+↑/↓` e visibilidade também em `:focus-visible`.
 *
 * A nova posição é anunciada por `aria-live` — a região fica no `TreeGrid`, uma
 * só para a grade inteira: uma por linha faria o leitor de tela anunciar do
 * lugar errado.
 */

interface Props {
  readonly label: string;
  readonly indexInParent: number;
  readonly siblingCount: number;
  /** Move a linha; `delta` é -1 ou +1. Devolve se moveu de fato. */
  readonly onMove: (delta: number) => boolean;
  readonly onDragStart: (event: DragEvent<HTMLButtonElement>) => void;
  readonly onDragEnd: () => void;
  /** Anuncia a nova posição para leitor de tela. */
  readonly onAnnounce: (message: string) => void;
}

export default function GripHandle({
  label,
  indexInParent,
  siblingCount,
  onMove,
  onDragStart,
  onDragEnd,
  onAnnounce,
}: Props) {
  const position = `${indexInParent + 1} de ${siblingCount}`;

  function handleKeyDown(event: KeyboardEvent<HTMLButtonElement>): void {
    // `Alt` para não conflitar com a navegação normal por setas, que o usuário
    // ainda precisa para percorrer a grade.
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) {
      return;
    }

    event.preventDefault();

    const delta = event.key === 'ArrowUp' ? -1 : 1;

    if (!onMove(delta)) {
      onAnnounce(
        `${label} já está ${delta < 0 ? 'na primeira' : 'na última'} posição de ${siblingCount}.`,
      );
      return;
    }

    onAnnounce(`${label} movido para a posição ${indexInParent + 1 + delta} de ${siblingCount}.`);
  }

  return (
    <button
      type="button"
      className="grip"
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onKeyDown={handleKeyDown}
      aria-label={`Reordenar ${label}, posição ${position}. Use Alt com as setas para mover.`}
      title="Arraste, ou Alt+↑/↓"
    >
      <Icon name="grip" size={13} />
    </button>
  );
}
