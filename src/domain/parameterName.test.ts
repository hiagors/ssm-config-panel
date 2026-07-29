import { describe, expect, it } from 'vitest';
import { InvalidParameterNameError } from './errors.js';
import { isValidParameterName, nameSegments, parseParameterName } from './parameterName.js';

describe('parseParameterName', () => {
  it('aceita name hierárquico', () => {
    expect(parseParameterName('/prod/billing/env')).toBe('/prod/billing/env');
  });

  it('aceita ponto, hífen e underscore no segmento', () => {
    expect(parseParameterName('/prod/my-app_v1.2/env')).toBe('/prod/my-app_v1.2/env');
  });

  it('remove espaço nas pontas', () => {
    expect(parseParameterName('  /prod/env  ')).toBe('/prod/env');
  });

  it('preserva a caixa original', () => {
    // Nomes no SSM são case-sensitive; normalizar aqui perderia informação.
    expect(parseParameterName('/Prod/Env')).toBe('/Prod/Env');
  });

  it.each([
    ['vazio', ''],
    ['só espaço', '   '],
    ['sem barra inicial', 'prod/env'],
    ['terminado em barra', '/prod/env/'],
    ['barra dupla', '/prod//env'],
    ['segmento .', '/prod/./env'],
    ['segmento ..', '/prod/../env'],
    ['espaço no meio', '/prod/my env'],
    ['caractere inválido', '/prod/env$'],
    ['prefixo reservado /aws', '/aws/service/ami'],
    ['prefixo reservado /ssm', '/ssm/foo'],
  ])('rejeita name %s', (_label, raw) => {
    expect(() => parseParameterName(raw)).toThrow(InvalidParameterNameError);
    expect(isValidParameterName(raw)).toBe(false);
  });

  it('rejeita travessia de diretório', () => {
    // Sem isso o codec de arquivo escreveria fora de ./.local-store.
    expect(() => parseParameterName('/../../etc/passwd')).toThrow(InvalidParameterNameError);
  });

  it('rejeita hierarquia acima de 15 níveis', () => {
    const deep = `/${Array.from({ length: 16 }, (_, i) => `n${i}`).join('/')}`;
    expect(() => parseParameterName(deep)).toThrow(/15 níveis/);
  });

  it('rejeita name acima de 2048 caracteres', () => {
    expect(() => parseParameterName(`/${'a'.repeat(2048)}`)).toThrow(/2048/);
  });

  it('a mensagem de erro diz o que corrigir', () => {
    expect(() => parseParameterName('prod/env')).toThrow(/precisa começar com "\/"/);
  });
});

describe('nameSegments', () => {
  it('quebra a hierarquia sem a barra inicial', () => {
    expect(nameSegments('/prod/billing/env')).toEqual(['prod', 'billing', 'env']);
  });

  it('funciona com um único nível', () => {
    expect(nameSegments('/env')).toEqual(['env']);
  });
});
