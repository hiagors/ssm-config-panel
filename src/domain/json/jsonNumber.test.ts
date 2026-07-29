import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NUMBER_LEXEME,
  areNumberLexemesEqual,
  describeNumberProblem,
  isIntegerLexeme,
  isValidNumberLexeme,
} from './jsonNumber.js';

describe('isValidNumberLexeme', () => {
  it.each([
    '0',
    '-0',
    '1',
    '-1',
    '42',
    '30.0',
    '3.14',
    '1.50',
    '1e5',
    '1E5',
    '1e+5',
    '1e-5',
    '-1.5e-3',
    '9007199254740993',
    '123456789012345678901234567890',
  ])('aceita %s', (raw) => {
    expect(isValidNumberLexeme(raw)).toBe(true);
  });

  it.each([
    ['sinal de mais', '+1'],
    ['ponto inicial', '.5'],
    ['ponto final', '5.'],
    ['zero à esquerda', '01'],
    ['hexadecimal', '0x10'],
    ['Infinity', 'Infinity'],
    ['NaN', 'NaN'],
    ['vazio', ''],
    ['só sinal', '-'],
    ['expoente incompleto', '1e'],
    ['expoente só com sinal', '1e+'],
    ['separador de milhar', '1,000'],
    ['espaço', '1 2'],
    ['texto', 'abc'],
  ])('rejeita %s', (_label, raw) => {
    expect(isValidNumberLexeme(raw)).toBe(false);
  });
});

describe('precisão — nenhum caminho passa por Number', () => {
  it('inteiro acima de 2^53 sobrevive como lexema', () => {
    // 2^53 = 9007199254740992. O próximo inteiro não é representável em
    // double: Number('9007199254740993') devolve 9007199254740992.
    const raw = '9007199254740993';

    expect(isValidNumberLexeme(raw)).toBe(true);
    expect(isIntegerLexeme(raw)).toBe(true);

    // A prova de que converter destruiria o dado.
    expect(String(Number(raw))).not.toBe(raw);
    expect(String(Number(raw))).toBe('9007199254740992');
  });

  it('inteiro muito maior que 2^53 sobrevive', () => {
    const raw = '123456789012345678901234567890';

    expect(isValidNumberLexeme(raw)).toBe(true);
    expect(isIntegerLexeme(raw)).toBe(true);
    expect(String(Number(raw))).not.toBe(raw);
  });

  it('expoente que estouraria para Infinity sobrevive', () => {
    const raw = '1e400';

    expect(isValidNumberLexeme(raw)).toBe(true);
    expect(Number(raw)).toBe(Number.POSITIVE_INFINITY);
  });

  it('zeros à direita do decimal sobrevivem', () => {
    for (const raw of ['30.0', '1.50', '0.000']) {
      expect(isValidNumberLexeme(raw)).toBe(true);
      expect(String(Number(raw))).not.toBe(raw);
    }
  });
});

describe('isIntegerLexeme', () => {
  it.each(['0', '-7', '42', '9007199254740993'])('%s tem forma de inteiro', (raw) => {
    expect(isIntegerLexeme(raw)).toBe(true);
  });

  it.each(['30.0', '3.14', '1e5', '1E5'])('%s tem forma de float', (raw) => {
    expect(isIntegerLexeme(raw)).toBe(false);
  });

  it('lexema inválido não é inteiro', () => {
    expect(isIntegerLexeme('01')).toBe(false);
  });
});

describe('areNumberLexemesEqual', () => {
  it('compara por texto, não por valor', () => {
    // 30 e 30.0 valem o mesmo, mas serializam diferente: o diff precisa
    // mostrar a mudança.
    expect(areNumberLexemesEqual('30', '30.0')).toBe(false);
    expect(areNumberLexemesEqual('1e3', '1000')).toBe(false);
    expect(areNumberLexemesEqual('42', '42')).toBe(true);
  });
});

describe('describeNumberProblem', () => {
  it('não reclama de lexema válido', () => {
    expect(describeNumberProblem('30.0')).toBeUndefined();
  });

  it.each([
    ['+1', /sinal de mais/],
    ['.5', /dígito antes do ponto/],
    ['5.', /dígito depois do ponto/],
    ['01', /zero à esquerda/],
    ['1e', /expoente/],
    ['NaN', /Infinity nem NaN/],
    ['1,000', /separador de milhar/],
    ['', /vazio/],
  ])('explica %s de forma acionável', (raw, pattern) => {
    expect(describeNumberProblem(raw)).toMatch(pattern);
  });
});

describe('DEFAULT_NUMBER_LEXEME', () => {
  it('é um lexema válido', () => {
    expect(isValidNumberLexeme(DEFAULT_NUMBER_LEXEME)).toBe(true);
  });
});
