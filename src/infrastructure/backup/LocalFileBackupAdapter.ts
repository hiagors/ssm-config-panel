import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BackupFailedError, BackupNotFoundError, isAppError } from '../../domain/errors.js';
import { nameSegments, parseParameterName } from '../../domain/parameterName.js';
import type {
  BackupEntry,
  BackupFileContents,
  BackupInput,
  BackupPort,
  BackupResult,
} from './BackupPort.js';
import type { RetentionLimit } from './retention.js';
import { planRetention, retentionFromEnvironment } from './retention.js';

/**
 * Backup em arquivos locais.
 *
 * Layout: `./.backups/<name como diretórios>/<timestamp>.json`. Para
 * `/prod/billing/env`, isso é `.backups/prod/billing/env/2026-…json` — `env`
 * vira diretório aqui, para o histórico de cada parâmetro ficar navegável no
 * Finder.
 *
 * **Arquivos com `0600`, diretórios com `0700`.** O conteúdo é valor de
 * parâmetro em texto claro, incluindo `SecureString` decriptado.
 *
 * Escrita atômica por temporário + rename, e por um motivo específico: o backup
 * é lido como prova de que a versão anterior está salva. Um arquivo truncado por
 * queda no meio da escrita seria pior que ausência, porque pareceria válido.
 *
 * ── Colisão de caixa ────────────────────────────────────────────────────────
 *
 * O APFS não distingue maiúsculas de minúsculas, mas o SSM sim: `/prod/env` e
 * `/Prod/env` são parâmetros diferentes e cairiam no mesmo diretório. A defesa
 * não é varrer o disco comparando caixa — é o `name` gravado **dentro** de cada
 * arquivo. Toda leitura confere, e backup de outro parâmetro é ignorado na
 * listagem e recusado na leitura.
 */
export class LocalFileBackupAdapter implements BackupPort {
  private readonly rootDir: string;

  constructor(
    rootDir = './.backups',
    private readonly maxVersions: RetentionLimit = retentionFromEnvironment(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rootDir = resolve(rootDir);
  }

  async save(input: BackupInput): Promise<BackupResult> {
    const parameterName = parseParameterName(input.metadata.name);
    const savedAt = this.now().toISOString();
    const directory = this.directoryFor(parameterName);

    const contents: BackupFileContents = {
      name: parameterName,
      version: input.metadata.version,
      type: input.metadata.type,
      tier: input.metadata.tier,
      keyId: input.metadata.keyId ?? null,
      savedAt,
      value: input.value,
    };

    const absolutePath = join(directory, `${fileNameFor(savedAt)}.json`);

    try {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await this.writeAtomically(absolutePath, `${JSON.stringify(contents, null, 2)}\n`);
    } catch (error) {
      if (isAppError(error)) {
        throw error;
      }
      // A mensagem do fs traz o caminho, não o conteúdo — mas por disciplina não
      // a repassamos: o caminho contém o name, e a mensagem é curada.
      throw new BackupFailedError(parameterName, 'não foi possível gravar o arquivo de backup');
    }

    const entry: BackupEntry = { savedAt, version: input.metadata.version, absolutePath };

    return { entry, pruned: await this.prune(parameterName) };
  }

  async list(parameterName: string): Promise<readonly BackupEntry[]> {
    return this.readEntries(parseParameterName(parameterName));
  }

  async read(parameterName: string, savedAt: string): Promise<BackupFileContents> {
    const name = parseParameterName(parameterName);
    const path = join(this.directoryFor(name), `${fileNameFor(savedAt)}.json`);
    const contents = await this.readContents(path);

    // `name` diferente significa que este arquivo é de outro parâmetro que
    // colidiu por caixa. Restaurar o valor errado seria o pior desfecho
    // possível num fluxo de rollback.
    if (contents === undefined || contents.name !== name) {
      throw new BackupNotFoundError(name, savedAt);
    }

    return contents;
  }

  /** `/prod/billing/env` -> `<root>/prod/billing/env`. */
  private directoryFor(parameterName: string): string {
    return join(this.rootDir, ...nameSegments(parameterName));
  }

  /** Aplica a retenção no diretório do parâmetro. */
  private async prune(parameterName: string): Promise<readonly BackupEntry[]> {
    const plan = planRetention(await this.readEntries(parameterName), this.maxVersions);

    for (const entry of plan.prune) {
      try {
        await rm(entry.absolutePath, { force: true });
      } catch {
        // Falha ao podar não invalida o backup que acabou de ser gravado: a rede
        // de proteção está de pé, só ficou mais lixo. Abortar aqui bloquearia o
        // save por um problema de limpeza.
        continue;
      }
    }

    return plan.prune;
  }

  /**
   * Backups do parâmetro, do mais recente para o mais antigo.
   *
   * Lê cada arquivo, e não só os nomes: a `version` que a UI mostra na tela de
   * rollback está dentro do envelope, e é ela que responde "restaurar isto me
   * leva de volta a qual versão". Um diretório de backup tem no máximo
   * `BACKUP_MAX_VERSIONS_PER_PARAMETER` arquivos, então o custo é limitado por
   * construção.
   */
  private async readEntries(parameterName: string): Promise<readonly BackupEntry[]> {
    const directory = this.directoryFor(parameterName);

    let fileNames: string[];
    try {
      fileNames = await readdir(directory);
    } catch {
      // Parâmetro nunca salvo é estado normal, não erro.
      return [];
    }

    const entries: BackupEntry[] = [];

    for (const fileName of fileNames) {
      if (!fileName.endsWith('.json') || fileName.includes('.tmp-')) {
        continue;
      }

      const savedAt = savedAtFrom(fileName);

      if (savedAt === undefined) {
        continue;
      }

      const absolutePath = join(directory, fileName);
      const contents = await this.readContents(absolutePath);

      // Arquivo ilegível, corrompido ou de outro parâmetro (colisão de caixa)
      // não entra na lista: melhor omitir do que oferecer para restaurar.
      if (contents === undefined || contents.name !== parameterName) {
        continue;
      }

      entries.push({ savedAt, version: contents.version, absolutePath });
    }

    return entries.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  /** `undefined` para ausente, ilegível ou com envelope inválido. */
  private async readContents(path: string): Promise<BackupFileContents | undefined> {
    let raw: string;
    try {
      raw = await readFile(path, 'utf8');
    } catch {
      return undefined;
    }

    try {
      // A mensagem do JSON.parse embute um trecho da entrada, que aqui é valor
      // de parâmetro. Por isso o catch é silencioso: nada dela sai daqui.
      return asBackupContents(JSON.parse(raw));
    } catch {
      return undefined;
    }
  }

  private async writeAtomically(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}`;

    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
}

/** Valida a forma do envelope. `undefined` quando não é um backup nosso. */
function asBackupContents(parsed: unknown): BackupFileContents | undefined {
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }

  const raw = parsed as Record<string, unknown>;

  if (typeof raw['name'] !== 'string' || typeof raw['value'] !== 'string') {
    return undefined;
  }

  return {
    name: raw['name'],
    version: typeof raw['version'] === 'number' ? raw['version'] : 0,
    type: typeof raw['type'] === 'string' ? raw['type'] : 'String',
    tier: typeof raw['tier'] === 'string' ? raw['tier'] : 'Standard',
    keyId: typeof raw['keyId'] === 'string' ? raw['keyId'] : null,
    savedAt: typeof raw['savedAt'] === 'string' ? raw['savedAt'] : '',
    value: raw['value'],
  };
}

/**
 * Timestamp em nome de arquivo.
 *
 * `:` é legal em APFS mas o Finder o exibe como `/`, e ferramentas de linha de
 * comando tropeçam. Trocamos por `-`, e a volta é determinística.
 */
export function fileNameFor(isoTimestamp: string): string {
  return isoTimestamp.replace(/:/g, '-');
}

/** Reconstrói o ISO a partir do nome do arquivo, ou `undefined` se não casar. */
export function savedAtFrom(fileName: string): string | undefined {
  const base = fileName.replace(/\.json$/, '');
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})\.(\d{3})Z$/.exec(base);

  if (match === null) {
    return undefined;
  }

  return `${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`;
}
