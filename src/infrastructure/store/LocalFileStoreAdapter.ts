import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  Parameter,
  ParameterMetadata,
  ParameterTier,
  ParameterType,
} from '../../domain/Parameter.js';
import { PARAMETER_TIERS, PARAMETER_TYPES } from '../../domain/Parameter.js';
import {
  ParameterAlreadyExistsError,
  ParameterNameCollisionError,
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

/** Segredo em texto claro: apenas o dono lê e escreve. */
const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

/**
 * Store local em arquivos, para desenvolver e testar sem tocar em conta AWS.
 *
 * ── Um arquivo por parâmetro, plano, autodescritivo ─────────────────────────
 *
 * `/prod/billing/env` mora em `.local-store/prod#billing#env.json`, e o arquivo
 * carrega valor **e** metadados juntos:
 *
 *     { "name": "/prod/billing/env", "type": "String", "tier": "Standard",
 *       "keyId": null, "version": 3, "value": "{\"A\":1}" }
 *
 * `#` como separador não é escolha estética: ele é **ilegal** em segmento de
 * name (ver `VALID_SEGMENT` em `domain/parameterName.ts`, que aceita só letra,
 * número, ponto, hífen e underscore). Isso torna a codificação injetiva — com
 * `_` como separador, `/a_b/c` e `/a/b/c` viraram o mesmo arquivo.
 *
 * O `name` dentro do arquivo é o que resolve a case-insensitivity do APFS sem
 * varredura de diretório. O macOS entrega `prod#env.json` para quem pede
 * `PROD#env.json`, então a checagem é comparar o `name` gravado com o que foi
 * pedido: diferente, é colisão, e falhamos alto em vez de devolver o parâmetro
 * errado. No SSM `/prod/env` e `/PROD/env` são parâmetros distintos, e devolver
 * um no lugar do outro — ou pior, sobrescrever — é erro sem sinal.
 *
 * ── Nota sobre `list()` ─────────────────────────────────────────────────────
 *
 * Como valor e metadados moram no mesmo arquivo, listar lê o valor do disco para
 * a memória do processo. É aceitável aqui e só aqui: é a mesma máquina, o mesmo
 * disco onde o valor já está em texto claro, e o `get` leria de todo jeito. A
 * garantia que importa continua de pé — `list()` devolve **apenas metadados**, e
 * nenhum valor atravessa a fronteira HTTP. No driver `aws`, onde a rede está no
 * meio, `list` usa `DescribeParameters`, que nunca traz valor.
 *
 * Os arquivos contêm segredos em texto claro e são criados com `0600`.
 */
export class LocalFileStoreAdapter implements ParameterStorePort {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = resolve(rootDir);
  }

  async list(options: ListOptions = {}): Promise<ParameterMetadata[]> {
    const prefix = options.pathPrefix ? parseParameterName(options.pathPrefix) : undefined;
    const found: ParameterMetadata[] = [];

    for (const fileName of await this.listFileNames()) {
      const record = await this.readRecord(join(this.rootDir, fileName));

      if (record === undefined) {
        // Arquivo solto que não é um parâmetro nosso: ignora em vez de falhar a
        // listagem inteira por causa de um arquivo estranho no diretório.
        continue;
      }

      if (prefix !== undefined && !matchesPrefix(record.metadata.name, prefix, options.recursive ?? true)) {
        continue;
      }

      found.push(record.metadata);
    }

    return found.sort((left, right) => left.name.localeCompare(right.name));
  }

  async get(name: string): Promise<Parameter> {
    const parameterName = parseParameterName(name);
    const record = await this.readRecord(this.pathFor(parameterName));

    if (record === undefined) {
      throw new ParameterNotFoundError(parameterName);
    }

    this.assertSameName(parameterName, record.metadata.name);

    return record;
  }

  async put(name: string, value: string, options: PutOptions): Promise<PutResult> {
    const parameterName = parseParameterName(name);
    const path = this.pathFor(parameterName);
    const existing = await this.readRecord(path);

    if (existing !== undefined) {
      this.assertSameName(parameterName, existing.metadata.name);
    }

    // A checagem de versão fica aqui, o mais perto possível da escrita, e não
    // só no use case. Não elimina a janela entre ler e gravar — o sistema de
    // arquivos não dá compare-and-swap — mas a reduz ao mínimo e vale para
    // qualquer chamador do port, não só para o caminho que eu escrevi.
    this.assertExpectedVersion(parameterName, options.expectedVersion, existing?.metadata.version);

    const version = (existing?.metadata.version ?? 0) + 1;

    const metadata: ParameterMetadata = {
      name: parameterName,
      type: options.type,
      tier: options.tier,
      keyId: options.type === 'SecureString' ? options.keyId : undefined,
      version,
      lastModifiedAt: new Date().toISOString(),
      description: options.description,
    };

    await this.writeAtomically(path, `${JSON.stringify(serialize(metadata, value), null, 2)}\n`);

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

  /**
   * O arquivo aberto é mesmo o parâmetro pedido?
   *
   * Em APFS case-insensitive, pedir `/PROD/env` abre o arquivo de `/prod/env`.
   * O `name` gravado dentro é a única fonte confiável de qual parâmetro é.
   */
  private assertSameName(requested: string, stored: string): void {
    if (stored !== requested) {
      throw new ParameterNameCollisionError(requested, `"${stored}"`);
    }
  }

  /**
   * `/prod/billing/env` -> `<root>/prod#billing#env.json`, sempre minúsculo.
   *
   * Minúsculo de propósito: é o que torna a detecção de colisão **estrutural**
   * em vez de dependente do sistema de arquivos. Pedir `/prod/ENV` resolve para
   * o mesmo arquivo de `/prod/env`, o `name` de dentro acusa a diferença, e o
   * comportamento é idêntico em APFS case-insensitive e em FS case-sensitive.
   * A caixa verdadeira do name não se perde: ela mora dentro do arquivo.
   */
  private pathFor(parameterName: string): string {
    return join(this.rootDir, `${parameterName.slice(1).split('/').join('#').toLowerCase()}.json`);
  }

  private async listFileNames(): Promise<string[]> {
    try {
      const entries = await readdir(this.rootDir);
      return entries.filter((entry) => entry.endsWith('.json') && !entry.includes('.tmp-'));
    } catch {
      // Store ainda não criado é estado normal, não erro: devolve vazio.
      return [];
    }
  }

  /**
   * Lê e valida um arquivo do store.
   *
   * `undefined` quando o arquivo não existe — ausência é estado normal, e quem
   * chama decide se isso é `ParameterNotFoundError` (leitura) ou criação
   * (escrita). Arquivo ilegível ou corrompido, ao contrário, **falha alto**:
   * devolver "não existe" para um parâmetro que está lá mas quebrado poderia
   * virar uma criação por cima de dado bom.
   */
  private async readRecord(path: string): Promise<Parameter | undefined> {
    let raw: string;

    try {
      raw = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        return undefined;
      }
      throw new StoreUnavailableError(
        `failed to read ${path}`,
        'Não foi possível ler um arquivo de ./.local-store. Verifique a permissão do diretório.',
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A mensagem do JSON.parse embute um trecho da entrada — e a entrada é o
      // valor do parâmetro. Nunca a repasse.
      throw new StoreUnavailableError(
        `invalid store file: ${path}`,
        'Um arquivo de ./.local-store está corrompido e não é JSON válido. ' +
          'Apague-o e rode `make seed`, ou conserte o arquivo à mão.',
      );
    }

    return deserialize(parsed);
  }

  /**
   * Escreve via arquivo temporário + rename, com `0600` desde a criação.
   *
   * O `mode` do `writeFile` só vale na criação, então o temporário nasce
   * restrito e o rename é atômico: nunca existe uma janela em que o segredo
   * esteja no disco com permissão frouxa ou o arquivo esteja pela metade.
   */
  private async writeAtomically(path: string, contents: string): Promise<void> {
    const tempPath = `${path}.tmp-${process.pid}`;

    try {
      await mkdir(this.rootDir, { recursive: true, mode: DIR_MODE });
      await writeFile(tempPath, contents, { encoding: 'utf8', mode: FILE_MODE, flag: 'wx' });
      await rename(tempPath, path);
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }
      throw new StoreUnavailableError(
        `failed to write ${path}`,
        'Não foi possível gravar em ./.local-store. Verifique a permissão do diretório.',
      );
    }
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

/** Envelope gravado em disco. Exportado para o seed usar a mesma forma. */
export function serialize(metadata: ParameterMetadata, value: string): Record<string, unknown> {
  return {
    name: metadata.name,
    type: metadata.type,
    tier: metadata.tier,
    keyId: metadata.keyId ?? null,
    version: metadata.version,
    lastModifiedAt: metadata.lastModifiedAt ?? null,
    description: metadata.description ?? null,
    value,
  };
}

/**
 * Reconstrói o parâmetro do envelope, tolerando campo ausente.
 *
 * `name` e `value` são obrigatórios: sem eles o arquivo não identifica um
 * parâmetro e é tratado como arquivo estranho no diretório. O resto cai em
 * default do SSM, para um arquivo escrito à mão continuar abrindo.
 */
function deserialize(parsed: unknown): Parameter | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;
  const name = raw['name'];
  const value = raw['value'];

  if (typeof name !== 'string' || name === '' || typeof value !== 'string') {
    return undefined;
  }

  return {
    metadata: {
      name,
      type: asParameterType(raw['type']) ?? 'String',
      tier: asParameterTier(raw['tier']) ?? 'Standard',
      keyId: asOptionalString(raw['keyId']),
      version: asPositiveInteger(raw['version']) ?? 1,
      lastModifiedAt: asOptionalString(raw['lastModifiedAt']),
      description: asOptionalString(raw['description']),
    },
    value,
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
