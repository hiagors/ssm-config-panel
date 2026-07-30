import { constants as fsConstants } from 'node:fs';
import type { Dirent } from 'node:fs';
import { access, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type {
  Parameter,
  ParameterMetadata,
  ParameterTier,
  ParameterType,
} from '../../domain/Parameter.js';
import { PARAMETER_TIERS, PARAMETER_TYPES } from '../../domain/Parameter.js';
import {
  ParameterAlreadyExistsError,
  ParameterNotFoundError,
  StoreUnavailableError,
  VersionMismatchError,
  isAppError,
} from '../../domain/errors.js';
import { parseParameterName } from '../../domain/parameterName.js';
import type {
  ListOptions,
  ParameterStorePort,
  PutOptions,
  PutResult,
} from './ParameterStorePort.js';
import { EXPECT_NEW_PARAMETER } from './ParameterStorePort.js';
import {
  META_SUFFIX,
  isMetaFile,
  parameterNameToMetaPath,
  parameterNameToValuePath,
  resolveExactCasePath,
  valuePathToParameterName,
} from './parameterFileName.js';

/** Segredo em texto claro: apenas o dono lê e escreve. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Store local em arquivos, para desenvolver e testar sem tocar em conta AWS.
 *
 * Espelha o formato do SSM: um arquivo por parameter name, contendo
 * exatamente o JSON do valor, sem achatamento para `.env`. Metadados ficam
 * em um sidecar `.meta.json` ao lado, porque o `put` precisa preservar
 * `Type`, `Tier` e `KeyId`.
 *
 * Os arquivos contêm segredos em texto claro e são criados com `0600`.
 */
export class LocalFileStoreAdapter implements ParameterStorePort {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async list(options: ListOptions = {}): Promise<ParameterMetadata[]> {
    const files = await this.walkValueFiles(this.rootDir);
    const prefix = options.pathPrefix ? parseParameterName(options.pathPrefix) : undefined;

    const found: ParameterMetadata[] = [];

    for (const absolutePath of files) {
      const relativePath = relative(this.rootDir, absolutePath);
      const name = valuePathToParameterName(relativePath);

      if (name === null) {
        continue;
      }

      if (prefix !== undefined && !matchesPrefix(name, prefix, options.recursive ?? true)) {
        continue;
      }

      found.push(await this.readMetadata(name, absolutePath));
    }

    return found.sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(name: string): Promise<Parameter> {
    const parameterName = parseParameterName(name);
    const { path, exists } = await this.resolveValuePath(parameterName);

    if (!exists) {
      throw new ParameterNotFoundError(parameterName);
    }

    // Nunca inclua o conteúdo lido em mensagem de erro: pode ser SecureString.
    const value = await this.readFileOrFail(path, parameterName);
    const metadata = await this.readMetadata(parameterName, path);

    return { metadata, value };
  }

  async put(name: string, value: string, options: PutOptions): Promise<PutResult> {
    const parameterName = parseParameterName(name);
    const { path, exists } = await this.resolveValuePath(parameterName);

    const previous = exists ? await this.readMetadata(parameterName, path) : undefined;

    // A checagem de versão fica aqui, o mais perto possível da escrita, e não
    // só no use case. Não elimina a janela entre ler e gravar — o sistema de
    // arquivos não dá compare-and-swap — mas a reduz ao mínimo e vale para
    // qualquer chamador do port, não só para o caminho que eu escrevi.
    this.assertExpectedVersion(parameterName, options.expectedVersion, previous?.version);

    const version = (previous?.version ?? 0) + 1;

    const metadata: ParameterMetadata = {
      name: parameterName,
      type: options.type,
      tier: options.tier,
      keyId: options.type === 'SecureString' ? options.keyId : undefined,
      version,
      lastModifiedAt: new Date().toISOString(),
      description: options.description,
    };

    await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
    await this.writeFileAtomically(path, value);
    await this.writeFileAtomically(
      join(this.rootDir, parameterNameToMetaPath(parameterName)),
      `${JSON.stringify(serializeMetadata(metadata), null, 2)}\n`,
    );

    return { version, tier: options.tier };
  }

  /**
   * Aplica o contrato de `PutOptions.expectedVersion`.
   *
   * `0` significa "espero criar"; `>= 1` significa "espero sobrescrever esta
   * versão exata". Qualquer divergência aborta antes de tocar no disco.
   */
  private assertExpectedVersion(
    parameterName: string,
    expectedVersion: number,
    currentVersion: number | undefined,
  ): void {
    if (expectedVersion === EXPECT_NEW_PARAMETER) {
      if (currentVersion !== undefined) {
        throw new ParameterAlreadyExistsError(parameterName, currentVersion);
      }
      return;
    }

    if (currentVersion === undefined) {
      // `PutParameter` com `Overwrite: true` criaria aqui. Não criamos: sem
      // original não há `Type`, `Tier` nem `KeyId` de onde herdar.
      throw new ParameterNotFoundError(parameterName);
    }

    if (currentVersion !== expectedVersion) {
      throw new VersionMismatchError(parameterName, expectedVersion, currentVersion);
    }
  }

  /** Resolve exigindo caixa exata; lança em colisão de case-insensitivity. */
  private async resolveValuePath(
    parameterName: string,
  ): Promise<{ path: string; exists: boolean }> {
    return resolveExactCasePath(
      this.rootDir,
      parameterName,
      parameterNameToValuePath(parameterName),
    );
  }

  private async readFileOrFail(path: string, parameterName: string): Promise<string> {
    try {
      return await readFile(path, 'utf8');
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }
      // A mensagem original do fs traz o caminho, não o conteúdo — mas por
      // disciplina não a repassamos.
      throw new StoreUnavailableError(
        `failed to read value file for ${parameterName}`,
        `Não foi possível ler o arquivo do parâmetro ${parameterName} em ./.local-store. ` +
          `Verifique se o arquivo existe e se a permissão permite leitura.`,
      );
    }
  }

  /** Lê o sidecar; na ausência dele, assume defaults do SSM. */
  private async readMetadata(
    parameterName: string,
    valuePath: string,
  ): Promise<ParameterMetadata> {
    const metaPath = `${valuePath.slice(0, -'.json'.length)}${META_SUFFIX}`;
    const fallback = await this.defaultMetadata(parameterName, valuePath);

    let raw: string;
    try {
      raw = await readFile(metaPath, 'utf8');
    } catch {
      return fallback;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // JSON.parse embute um trecho da entrada na mensagem — nunca a repasse.
      throw new StoreUnavailableError(
        `invalid metadata sidecar for ${parameterName}`,
        `O arquivo de metadados de ${parameterName} está corrompido. ` +
          `Apague o sidecar .meta.json correspondente em ./.local-store para regenerá-lo com os defaults.`,
      );
    }

    return mergeMetadata(fallback, parsed);
  }

  private async defaultMetadata(
    parameterName: string,
    valuePath: string,
  ): Promise<ParameterMetadata> {
    let lastModifiedAt: string | undefined;
    try {
      lastModifiedAt = (await stat(valuePath)).mtime.toISOString();
    } catch {
      lastModifiedAt = undefined;
    }

    return {
      name: parameterName,
      type: 'String',
      tier: 'Standard',
      keyId: undefined,
      version: 1,
      lastModifiedAt,
      description: undefined,
    };
  }

  /**
   * Escreve via arquivo temporário + rename, com `0600` desde a criação.
   *
   * O `mode` do `writeFile` só vale na criação, então o temporário nasce
   * restrito e o rename é atômico: nunca existe uma janela em que o segredo
   * esteja no disco com permissão frouxa ou o arquivo esteja pela metade.
   */
  private async writeFileAtomically(path: string, contents: string): Promise<void> {
    const tempPath = `${path}.tmp-${process.pid}`;

    try {
      await mkdir(dirname(path), { recursive: true, mode: DIR_MODE });
      await writeFile(tempPath, contents, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
      await rename(tempPath, path);
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }
      throw new StoreUnavailableError(
        `failed to write ${path}`,
        `Não foi possível gravar em ./.local-store. Verifique a permissão do diretório.`,
      );
    }
  }

  private async walkValueFiles(dir: string): Promise<string[]> {
    let entries: Dirent[];

    try {
      await access(dir, fsConstants.R_OK);
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      // Store ainda não criado é estado normal, não erro: devolve vazio.
      return [];
    }

    const files: string[] = [];

    for (const entry of entries) {
      const absolutePath = join(dir, entry.name);

      if (entry.isDirectory()) {
        files.push(...(await this.walkValueFiles(absolutePath)));
        continue;
      }

      // Sidecars de metadados e temporários de escrita não são parâmetros.
      if (isMetaFile(entry.name) || entry.name.includes('.tmp-')) {
        continue;
      }

      if (entry.name.endsWith('.json')) {
        files.push(absolutePath);
      }
    }

    return files;
  }
}

function matchesPrefix(name: string, prefix: string, recursive: boolean): boolean {
  if (!name.startsWith(`${prefix}/`)) {
    return false;
  }
  if (recursive) {
    return true;
  }
  return !name.slice(prefix.length + 1).includes('/');
}

function serializeMetadata(metadata: ParameterMetadata): Record<string, unknown> {
  return {
    type: metadata.type,
    tier: metadata.tier,
    keyId: metadata.keyId ?? null,
    version: metadata.version,
    lastModifiedAt: metadata.lastModifiedAt ?? null,
    description: metadata.description ?? null,
  };
}

/** Aplica o sidecar sobre os defaults, ignorando campo com formato inválido. */
function mergeMetadata(fallback: ParameterMetadata, parsed: unknown): ParameterMetadata {
  if (typeof parsed !== 'object' || parsed === null) {
    return fallback;
  }

  const raw = parsed as Record<string, unknown>;

  return {
    name: fallback.name,
    type: asParameterType(raw['type']) ?? fallback.type,
    tier: asParameterTier(raw['tier']) ?? fallback.tier,
    keyId: asOptionalString(raw['keyId']),
    version: asPositiveInteger(raw['version']) ?? fallback.version,
    lastModifiedAt: asOptionalString(raw['lastModifiedAt']) ?? fallback.lastModifiedAt,
    description: asOptionalString(raw['description']),
  };
}

function asParameterType(value: unknown): ParameterType | undefined {
  return PARAMETER_TYPES.find((candidate) => candidate === value);
}

function asParameterTier(value: unknown): ParameterTier | undefined {
  return PARAMETER_TIERS.find((candidate) => candidate === value);
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
