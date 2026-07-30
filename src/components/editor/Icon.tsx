/**
 * Os seis ícones da árvore, como SVG inline.
 *
 * Inline, e não fonte de ícones: o mockup usa Tabler via `<i class="ti ...">`,
 * que exigiria uma fonte externa. Este app não busca recurso de fora — e uma
 * dependência de fonte para seis glifos não se paga.
 *
 * `currentColor` em tudo, para o ícone herdar a cor do contexto em vez de cada
 * uso ter de combinar com a paleta na mão.
 */

export type IconName = 'chevron' | 'grip' | 'x' | 'plus' | 'eye' | 'kebab';

interface Props {
  readonly name: IconName;
  /** Graus de rotação. Usado no chevron: 0 = fechado, 90 = aberto. */
  readonly rotate?: number;
  readonly size?: number;
}

export default function Icon({ name, rotate = 0, size = 14 }: Props) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      // Decorativo: quem descreve a ação é o `aria-label` do botão.
      aria-hidden="true"
      focusable="false"
      style={rotate === 0 ? undefined : { transform: `rotate(${rotate}deg)` }}
    >
      {paths(name)}
    </svg>
  );
}

function paths(name: IconName) {
  switch (name) {
    case 'chevron':
      return <path d="M6 3.5 10.5 8 6 12.5" />;

    case 'grip':
      // Seis pontos, o vocabulário usual de "arraste aqui".
      return (
        <g fill="currentColor" stroke="none">
          <circle cx="6" cy="4" r="1.1" />
          <circle cx="10" cy="4" r="1.1" />
          <circle cx="6" cy="8" r="1.1" />
          <circle cx="10" cy="8" r="1.1" />
          <circle cx="6" cy="12" r="1.1" />
          <circle cx="10" cy="12" r="1.1" />
        </g>
      );

    case 'x':
      return (
        <>
          <path d="M4 4l8 8" />
          <path d="M12 4l-8 8" />
        </>
      );

    case 'plus':
      return (
        <>
          <path d="M8 3.5v9" />
          <path d="M3.5 8h9" />
        </>
      );

    case 'eye':
      return (
        <>
          <path d="M1.5 8s2.5-4 6.5-4 6.5 4 6.5 4-2.5 4-6.5 4S1.5 8 1.5 8Z" />
          <circle cx="8" cy="8" r="1.8" />
        </>
      );

    case 'kebab':
      return (
        <g fill="currentColor" stroke="none">
          <circle cx="8" cy="3.5" r="1.2" />
          <circle cx="8" cy="8" r="1.2" />
          <circle cx="8" cy="12.5" r="1.2" />
        </g>
      );
  }
}
