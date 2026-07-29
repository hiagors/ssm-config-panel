import type { ParameterTier } from '../../domain/Parameter.js';
import { TIER_VALUE_LIMIT_BYTES, valueSizeInBytes } from '../../domain/Parameter.js';
import type { JsonDocument, JsonNode } from '../../domain/json/JsonDocument.js';
import { describeNumberProblem, isValidNumberLexeme } from '../../domain/json/jsonNumber.js';
import type { EditPath } from '../../domain/json/jsonPath.js';
import { childPath, displayPath, pathKey } from '../../domain/json/jsonPath.js';
import { serializeJsonDocument } from '../../domain/json/serializeJsonDocument.js';

/**
 * Validação do documento antes de salvar. Função pura, sem I/O.
 *
 * Nenhuma mensagem interpola valor de campo — só chave e caminho, que são
 * estrutura, não segredo. `SecureString` mascara valores, e uma mensagem de
 * validação que ecoasse o conteúdo derrotaria o mascaramento.
 */

export type ValidationSeverity = 'error' | 'warning';

export type ValidationCode =
  | 'INVALID_JSON'
  | 'EMPTY_KEY'
  | 'DUPLICATE_KEY'
  | 'INVALID_NUMBER'
  | 'SIZE_WARNING'
  | 'SIZE_EXCEEDED';

export interface ValidationIssue {
  readonly severity: ValidationSeverity;
  readonly code: ValidationCode;
  /** Caminho por índice, para a UI focar o campo. Vazio quando é do documento. */
  readonly path: EditPath;
  /** Caminho legível, para a mensagem. */
  readonly label: string;
  readonly message: string;
}

export interface ValidationResult {
  readonly issues: readonly ValidationIssue[];
  readonly errorCount: number;
  readonly warningCount: number;
  /** `false` quando existe pelo menos um erro. Aviso não bloqueia. */
  readonly canSave: boolean;
  readonly sizeInBytes: number;
  readonly sizeLimitInBytes: number;
}

/** A partir de que fração do limite do tier o aviso aparece. */
const SIZE_WARNING_RATIO = 0.9;

export function validateDocument(
  document: JsonDocument,
  tier: ParameterTier,
): ValidationResult {
  const issues: ValidationIssue[] = [];

  collectNodeIssues(document, document.root, [], issues);

  const serialized = serializeJsonDocument(document);
  const sizeInBytes = valueSizeInBytes(serialized);
  const sizeLimitInBytes = TIER_VALUE_LIMIT_BYTES[tier];

  if (sizeInBytes > sizeLimitInBytes) {
    issues.push({
      severity: 'error',
      code: 'SIZE_EXCEEDED',
      path: [],
      label: '(documento)',
      message:
        `O valor tem ${sizeInBytes} bytes e excede o limite de ${sizeLimitInBytes} bytes ` +
        `do tier ${tier}. O SSM vai rejeitar a gravação.`,
    });
  } else if (sizeInBytes >= sizeLimitInBytes * SIZE_WARNING_RATIO) {
    issues.push({
      severity: 'warning',
      code: 'SIZE_WARNING',
      path: [],
      label: '(documento)',
      message:
        `O valor está em ${sizeInBytes} de ${sizeLimitInBytes} bytes do tier ${tier}. ` +
        `Perto do limite.`,
    });
  }

  const errorCount = issues.filter((issue) => issue.severity === 'error').length;

  return {
    issues,
    errorCount,
    warningCount: issues.length - errorCount,
    canSave: errorCount === 0,
    sizeInBytes,
    sizeLimitInBytes,
  };
}

function collectNodeIssues(
  document: JsonDocument,
  node: JsonNode,
  path: EditPath,
  issues: ValidationIssue[],
): void {
  if (node.kind === 'number' && !isValidNumberLexeme(node.raw)) {
    issues.push({
      severity: 'error',
      code: 'INVALID_NUMBER',
      path,
      label: displayPath(document.root, path),
      // O motivo é estrutural; o lexema em si não é interpolado.
      message: `Número inválido em ${displayPath(document.root, path)}: ${
        describeNumberProblem(node.raw) ?? 'não é um número JSON válido'
      }.`,
    });
  }

  if (node.kind === 'object') {
    const seen = new Map<string, number>();

    node.entries.forEach((entry, index) => {
      const entryPath = childPath(path, index);

      if (entry.key === '') {
        issues.push({
          severity: 'error',
          code: 'EMPTY_KEY',
          path: entryPath,
          label: displayPath(document.root, entryPath),
          message: `Chave vazia em ${displayPath(document.root, path)}. Toda chave precisa de nome.`,
        });
      }

      const firstIndex = seen.get(entry.key);

      if (firstIndex === undefined) {
        seen.set(entry.key, index);
      } else if (entry.key !== '') {
        // JSON.parse descartaria uma das duas em silêncio; aqui as duas
        // existem no modelo justamente para poder acusar.
        issues.push({
          severity: 'error',
          code: 'DUPLICATE_KEY',
          path: entryPath,
          label: displayPath(document.root, entryPath),
          message:
            `Chave "${entry.key}" duplicada em ${displayPath(document.root, path)} ` +
            `(posições ${firstIndex + 1} e ${index + 1}). JSON não permite chave repetida.`,
        });
      }

      collectNodeIssues(document, entry.value, entryPath, issues);
    });

    return;
  }

  if (node.kind === 'array') {
    node.items.forEach((item, index) => {
      collectNodeIssues(document, item, childPath(path, index), issues);
    });
  }
}

/** Índice de problemas por caminho, para a UI marcar cada campo. */
export function issuesByPath(
  result: ValidationResult,
): ReadonlyMap<string, readonly ValidationIssue[]> {
  const map = new Map<string, ValidationIssue[]>();

  for (const issue of result.issues) {
    const key = pathKey(issue.path);
    const existing = map.get(key);

    if (existing === undefined) {
      map.set(key, [issue]);
    } else {
      existing.push(issue);
    }
  }

  return map;
}
