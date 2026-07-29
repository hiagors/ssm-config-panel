import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { InvalidParameterNameError, ParameterNameCollisionError } from '../../domain/errors.js';
import { nameSegments, parseParameterName } from '../../domain/parameterName.js';

/**
 * Codec entre o name do parameter e o caminho no store local.
 *
 * O layout espelha a hierarquia do SSM em diretórios, para o store ficar
 * legível no Finder:
 *
 *   /prod/billing/env  ->  .local-store/prod/billing/env.json
 *                          .local-store/prod/billing/env.meta.json
 *
 * O arquivo de valor contém exatamente o JSON do valor, sem envelope, como
 * o spec exige. Os metadados (Type, Tier, KeyId, Version) vão no sidecar,
 * porque o save da Fase 2 precisa preservá-los.
 */

export const VALUE_SUFFIX = '.json';
export const META_SUFFIX = '.meta.json';

/**
 * Um name terminado em `.meta` produziria `x.meta.json`, indistinguível do
 * sidecar de `/…/x`. Rejeitamos na entrada em vez de inventar escape.
 */
const FORBIDDEN_LAST_SEGMENT_SUFFIX = '.meta';

/** `/prod/billing/env` -> `prod/billing/env.json` (relativo à raiz do store). */
export function parameterNameToValuePath(name: string): string {
  return `${relativePathWithoutSuffix(name)}${VALUE_SUFFIX}`;
}

/** `/prod/billing/env` -> `prod/billing/env.meta.json`. */
export function parameterNameToMetaPath(name: string): string {
  return `${relativePathWithoutSuffix(name)}${META_SUFFIX}`;
}

function relativePathWithoutSuffix(name: string): string {
  const segments = nameSegments(name);
  const last = segments[segments.length - 1] as string;

  if (last.toLowerCase().endsWith(FORBIDDEN_LAST_SEGMENT_SUFFIX)) {
    throw new InvalidParameterNameError(
      `o último segmento não pode terminar em "${FORBIDDEN_LAST_SEGMENT_SUFFIX}", ` +
        `porque colidiria com o arquivo de metadados de "${name.slice(0, -FORBIDDEN_LAST_SEGMENT_SUFFIX.length)}"`,
    );
  }

  return segments.join('/');
}

/** `true` para o sidecar de metadados. O `list()` usa isso para excluí-los. */
export function isMetaFile(relativePath: string): boolean {
  return relativePath.endsWith(META_SUFFIX);
}

/** `true` para arquivo de valor: termina em `.json` mas não em `.meta.json`. */
export function isValueFile(relativePath: string): boolean {
  return relativePath.endsWith(VALUE_SUFFIX) && !isMetaFile(relativePath);
}

/**
 * `prod/billing/env.json` -> `/prod/billing/env`.
 *
 * Aceita separador de qualquer plataforma. Devolve `null` quando o caminho
 * não é arquivo de valor, para o `list()` simplesmente ignorar.
 */
export function valuePathToParameterName(relativePath: string): string | null {
  if (!isValueFile(relativePath)) {
    return null;
  }

  const withoutSuffix = relativePath.slice(0, -VALUE_SUFFIX.length);
  const normalized = withoutSuffix.split(sep).join('/');
  const name = `/${normalized}`;

  try {
    return parseParameterName(name);
  } catch {
    // Arquivo solto no store que não corresponde a um name válido.
    return null;
  }
}

/**
 * Resolve o caminho absoluto exigindo correspondência exata de caixa em
 * cada nível, e falha alto quando existe uma variante que só difere na caixa.
 *
 * Sem isso o macOS entrega o parâmetro errado sem avisar: em APFS
 * case-insensitive, `open('.local-store/PROD/env.json')` abre com sucesso o
 * arquivo criado como `prod/env.json`. Um `get('/PROD/env')` devolveria o
 * valor de `/prod/env`, e um `put` sobrescreveria o parâmetro errado — que no
 * SSM é outro parâmetro. O `readdir` devolve a caixa real gravada no disco,
 * então comparar contra ele é o que torna a checagem confiável.
 *
 * Nunca lança por ausência: devolve `exists: false` e deixa o chamador
 * decidir (leitura vira `ParameterNotFoundError`, escrita cria o caminho).
 * A única exceção que sai daqui é a colisão de caixa.
 */
export async function resolveExactCasePath(
  rootDir: string,
  parameterName: string,
  relativePath: string,
): Promise<{ path: string; exists: boolean }> {
  const segments = relativePath.split('/');
  let currentDir = rootDir;

  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;

    let entries: string[];
    try {
      entries = await readdir(currentDir);
    } catch {
      // Diretório intermediário ainda não existe. Em escrita isso é normal;
      // em leitura significa que o parâmetro não está no store.
      return { path: join(rootDir, ...segments), exists: false };
    }

    if (entries.includes(segment)) {
      currentDir = join(currentDir, segment);
      continue;
    }

    const variant = entries.find(
      (entry) => entry.toLowerCase() === segment.toLowerCase(),
    );

    if (variant !== undefined) {
      throw new ParameterNameCollisionError(
        parameterName,
        describeCollidingName(segments, i, variant),
      );
    }

    // Não existe entrada com esta caixa nem com outra: o caminho está livre.
    return { path: join(rootDir, ...segments), exists: false };
  }

  return { path: currentDir, exists: true };
}

/**
 * Reconstrói o que já existe no disco, para a mensagem de erro.
 *
 * A colisão pode acontecer no último segmento (o arquivo do parâmetro) ou em
 * um diretório intermediário. Nos dois casos o texto tem de dizer qual, senão
 * `/EXAMPLE/demo/env` colidindo com o diretório `example` viraria a mensagem
 * enigmática "colide com /example".
 */
function describeCollidingName(
  segments: string[],
  collidingIndex: number,
  actualEntry: string,
): string {
  const isLastSegment = collidingIndex === segments.length - 1;
  const parts = segments.slice(0, collidingIndex).concat(actualEntry);

  if (isLastSegment) {
    const last = parts[parts.length - 1] as string;
    const withoutSuffix = last.endsWith(VALUE_SUFFIX)
      ? last.slice(0, -VALUE_SUFFIX.length)
      : last;
    return `"/${parts.slice(0, -1).concat(withoutSuffix).join('/')}"`;
  }

  return `o prefixo "/${parts.join('/')}"`;
}
