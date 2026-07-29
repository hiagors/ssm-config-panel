import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ValueInput, { MASKED_PLACEHOLDER } from './ValueInput.js';

/**
 * Testa o **markup gerado**, não os props.
 *
 * A razão de existir deste componente é emitir três atributos em todo input
 * de valor. Testar os props provaria só que eu escrevi o que escrevi; testar
 * o HTML prova que chega no browser. Usa `renderToStaticMarkup`, que roda em
 * Node puro e não precisa de jsdom.
 *
 * Sobre a caixa dos nomes: o React 19 emite `autoComplete="off"`, em
 * camelCase. O parser de HTML trata nome de atributo como case-insensitive,
 * então o browser lê `autocomplete`. Os dois atributos que realmente desligam
 * o 1Password e o LastPass são `data-*`, e esses já saem em minúsculas.
 */

function render(node: React.ReactElement): string {
  return renderToStaticMarkup(node);
}

const noop = (): void => undefined;

describe('ValueInput — supressão de gerenciador de senha', () => {
  it('emite os três atributos em campo de texto', () => {
    const html = render(<ValueInput value="x" onChange={noop} ariaLabel="Valor de a" />);

    expect(html).toMatch(/autoComplete="off"/i);
    expect(html).toContain('data-1p-ignore=""');
    expect(html).toContain('data-lpignore="true"');
  });

  it('emite os três atributos em campo numérico', () => {
    const html = render(
      <ValueInput value="30.0" numeric onChange={noop} ariaLabel="Valor de a" />,
    );

    expect(html).toMatch(/autoComplete="off"/i);
    expect(html).toContain('data-1p-ignore=""');
    expect(html).toContain('data-lpignore="true"');
  });

  it('emite os três atributos em campo mascarado', () => {
    const html = render(
      <ValueInput value="segredo" masked onChange={noop} ariaLabel="Valor de a" />,
    );

    expect(html).toMatch(/autoComplete="off"/i);
    expect(html).toContain('data-1p-ignore=""');
    expect(html).toContain('data-lpignore="true"');
  });

  it('emite os três atributos em campo desabilitado', () => {
    const html = render(
      <ValueInput value="null" disabled onChange={noop} ariaLabel="Valor de a" />,
    );

    expect(html).toMatch(/autoComplete="off"/i);
    expect(html).toContain('data-1p-ignore=""');
    expect(html).toContain('data-lpignore="true"');
  });

  it('desliga corretor e capitalização automática', () => {
    const html = render(<ValueInput value="x" onChange={noop} ariaLabel="Valor de a" />);

    expect(html).toMatch(/spellCheck="false"/i);
    expect(html).toMatch(/autoCapitalize="off"/i);
    expect(html).toMatch(/autoCorrect="off"/i);
  });
});

describe('ValueInput — nunca usa type que dispare o gerenciador', () => {
  it('não usa type="password" nem para mascarar', () => {
    // type="password" é exatamente o que faz o gerenciador se oferecer.
    const html = render(
      <ValueInput value="segredo" masked onChange={noop} ariaLabel="Valor de a" />,
    );

    expect(html).not.toContain('type="password"');
    expect(html).toContain('type="text"');
  });

  it('não usa type="number" nem em campo numérico', () => {
    // O browser normaliza e às vezes esvazia o valor de type="number", o que
    // destruiria o lexema: 30.0 viraria 30.
    const html = render(
      <ValueInput value="9007199254740993" numeric onChange={noop} ariaLabel="Valor de a" />,
    );

    expect(html).not.toContain('type="number"');
    expect(html).toContain('type="text"');
    expect(html).toMatch(/inputMode="decimal"/i);
  });
});

describe('ValueInput — mascaramento tira o valor do DOM', () => {
  it('valor mascarado não aparece no HTML', () => {
    const secret = 'sk-live-NUNCA-DEVE-APARECER';

    const html = render(
      <ValueInput value={secret} masked onChange={noop} ariaLabel="Valor de a" />,
    );

    // Máscara não é CSS: é ausência do dado.
    expect(html).not.toContain(secret);
    expect(html).toContain(MASKED_PLACEHOLDER);
  });

  it('campo mascarado é somente-leitura, para não editar o que não se vê', () => {
    const html = render(<ValueInput value="x" masked onChange={noop} ariaLabel="Valor de a" />);

    expect(html).toMatch(/readOnly=""/i);
  });

  it('revelado mostra o valor e volta a ser editável', () => {
    const html = render(<ValueInput value="visivel" onChange={noop} ariaLabel="Valor de a" />);

    expect(html).toContain('value="visivel"');
    expect(html).not.toMatch(/readOnly=""/i);
  });

  it('preserva lexema numérico grande quando revelado', () => {
    const html = render(
      <ValueInput value="9007199254740993" numeric onChange={noop} ariaLabel="Valor de a" />,
    );

    expect(html).toContain('value="9007199254740993"');
  });
});

describe('ValueInput — acessibilidade', () => {
  it('leva o aria-label recebido', () => {
    const html = render(<ValueInput value="x" onChange={noop} ariaLabel="Valor de PORT" />);

    expect(html).toContain('aria-label="Valor de PORT"');
  });

  it('marca aria-invalid quando inválido', () => {
    const html = render(<ValueInput value="1e" numeric invalid onChange={noop} ariaLabel="a" />);

    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('invalid');
  });

  it('não marca aria-invalid quando válido', () => {
    const html = render(<ValueInput value="1" numeric onChange={noop} ariaLabel="a" />);

    expect(html).not.toContain('aria-invalid');
  });
});
