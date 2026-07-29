/**
 * Números JSON tratados como **lexema**, nunca como `number` do JavaScript.
 *
 * Nenhuma função deste arquivo — nem do resto do editor — chama `Number()`,
 * `parseFloat()`, `parseInt()` ou `JSON.parse()` em um número. O motivo é
 * perda silenciosa de informação:
 *
 *   Number('9007199254740993')  === 9007199254740992   // 2^53+1 não cabe
 *   Number('30.0')              === 30                 // vira "30" ao serializar
 *   Number('1.50')              === 1.5                // vira "1.5"
 *   Number('1e400')             === Infinity           // e Infinity não é JSON
 *
 * O SSM guarda o parâmetro como texto. Se o editor converter para `number`
 * para validar ou comparar, o round-trip deixa de ser estável e um campo que
 * ninguém tocou aparece alterado no diff. Então validamos por gramática e
 * comparamos por texto.
 */

/**
 * A gramática de número do JSON (RFC 8259), literal.
 *
 * Rejeita o que o JavaScript aceitaria: `+1`, `.5`, `5.`, `01`, `0x10`,
 * `Infinity`, `NaN`, separador de milhar.
 */
const JSON_NUMBER = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

/** `true` quando o lexema é um número JSON válido. Não converte nada. */
export function isValidNumberLexeme(raw: string): boolean {
  return JSON_NUMBER.test(raw);
}

/**
 * `true` quando o lexema tem forma de inteiro: sem ponto e sem expoente.
 *
 * É a distinção que a UI usa para o seletor de tipo e que a serialização
 * preserva. `1e3` conta como forma de float, mesmo valendo 1000: o que
 * importa é o texto que volta para o store.
 */
export function isIntegerLexeme(raw: string): boolean {
  return isValidNumberLexeme(raw) && !/[.eE]/.test(raw);
}

/**
 * Compara dois lexemas por igualdade **textual**.
 *
 * `30` e `30.0` são considerados diferentes de propósito: serializam
 * diferente, então o diff deve mostrar a mudança. Comparar por valor
 * numérico esconderia uma alteração real no que vai ser gravado.
 */
export function areNumberLexemesEqual(left: string, right: string): boolean {
  return left === right;
}

/** Lexema inicial ao trocar o tipo de um campo para `number`. */
export const DEFAULT_NUMBER_LEXEME = '0';

/**
 * Descreve por que o lexema é inválido, em texto acionável.
 *
 * Nunca inclui o lexema quando ele pode ter vindo de um `SecureString`; o
 * chamador decide se interpola. Aqui só o motivo.
 */
export function describeNumberProblem(raw: string): string | undefined {
  if (isValidNumberLexeme(raw)) {
    return undefined;
  }
  if (raw.trim() === '') {
    return 'o número está vazio';
  }
  if (/^[+]/.test(raw)) {
    return 'JSON não aceita sinal de mais no início';
  }
  if (/^-?\./.test(raw)) {
    return 'JSON exige um dígito antes do ponto decimal';
  }
  if (/\.$/.test(raw)) {
    return 'JSON exige ao menos um dígito depois do ponto decimal';
  }
  if (/^-?0[0-9]/.test(raw)) {
    return 'JSON não aceita zero à esquerda';
  }
  if (/[eE][+-]?$/.test(raw)) {
    return 'o expoente está incompleto';
  }
  if (/^-?(Infinity|NaN)$/.test(raw)) {
    return 'JSON não tem Infinity nem NaN';
  }
  if (/,/.test(raw)) {
    return 'JSON não aceita separador de milhar';
  }
  return 'não é um número JSON válido';
}
