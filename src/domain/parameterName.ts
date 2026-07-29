import { InvalidParameterNameError } from './errors.js';

/**
 * Validação do name do parameter.
 *
 * As regras seguem as do SSM, com um acréscimo nosso: exigimos a barra
 * inicial. O SSM aceita names sem barra (`foo`) e os trata como `/foo`, mas
 * permitir as duas grafias criaria dois caminhos para o mesmo parâmetro e
 * quebraria o codec de arquivo. Normalizamos na fronteira, uma vez.
 */

/** Limite do SSM para o name completo, incluindo a hierarquia. */
export const MAX_NAME_LENGTH = 2048;

/** Profundidade máxima de hierarquia aceita pelo SSM. */
export const MAX_HIERARCHY_DEPTH = 15;

/** Caracteres válidos em um segmento: letra, número e `. - _`. */
const VALID_SEGMENT = /^[a-zA-Z0-9._-]+$/;

/** Prefixos reservados pela AWS. */
const RESERVED_PREFIXES = ['/aws', '/ssm'];

/**
 * Valida e normaliza um name.
 *
 * @throws {InvalidParameterNameError} com motivo acionável.
 */
export function parseParameterName(raw: string): string {
  if (typeof raw !== 'string') {
    throw new InvalidParameterNameError('o name precisa ser um texto');
  }

  const name = raw.trim();

  if (name.length === 0) {
    throw new InvalidParameterNameError('o name não pode ser vazio');
  }

  if (!name.startsWith('/')) {
    throw new InvalidParameterNameError(
      `o name precisa começar com "/" (recebido: "${name}")`,
    );
  }

  if (name.length > MAX_NAME_LENGTH) {
    throw new InvalidParameterNameError(
      `o name excede ${MAX_NAME_LENGTH} caracteres (tem ${name.length})`,
    );
  }

  if (name.endsWith('/')) {
    throw new InvalidParameterNameError('o name não pode terminar com "/"');
  }

  if (name.includes('//')) {
    throw new InvalidParameterNameError('o name não pode conter "//"');
  }

  const segments = name.slice(1).split('/');

  if (segments.length > MAX_HIERARCHY_DEPTH) {
    throw new InvalidParameterNameError(
      `o name excede ${MAX_HIERARCHY_DEPTH} níveis de hierarquia (tem ${segments.length})`,
    );
  }

  for (const segment of segments) {
    if (segment === '.' || segment === '..') {
      throw new InvalidParameterNameError(
        `o segmento "${segment}" não é permitido`,
      );
    }
    if (!VALID_SEGMENT.test(segment)) {
      throw new InvalidParameterNameError(
        `o segmento "${segment}" tem caractere inválido; use apenas letras, números, ponto, hífen e underscore`,
      );
    }
  }

  const lower = name.toLowerCase();
  for (const prefix of RESERVED_PREFIXES) {
    if (lower === prefix || lower.startsWith(`${prefix}/`)) {
      throw new InvalidParameterNameError(
        `o prefixo "${prefix}" é reservado pela AWS`,
      );
    }
  }

  return name;
}

/** Versão sem exceção, para validar em UI enquanto o usuário digita. */
export function isValidParameterName(raw: string): boolean {
  try {
    parseParameterName(raw);
    return true;
  } catch {
    return false;
  }
}

/** Segmentos do name, sem a barra inicial. `/a/b/c` -> `['a','b','c']`. */
export function nameSegments(name: string): string[] {
  return parseParameterName(name).slice(1).split('/');
}
