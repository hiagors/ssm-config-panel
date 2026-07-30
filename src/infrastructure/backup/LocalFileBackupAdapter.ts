import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { BackupFailedError, ParameterNameCollisionError, isAppError } from '../../domain/errors.js';
import { nameSegments, parseParameterName } from '../../domain/parameterName.js';
import type {
  BackupEntry,
  BackupFileContents,
  BackupInput,
  BackupPort,
  BackupResult,
} from './BackupPort.js';
import type { RetentionLimits } from './retention.js';
import { planRetention, retentionFromEnvironment } from './retention.js';

/**
 * Backup em arquivos locais.
 *
 * Layout: `./.backups/<name como diretórios>/<timestamp>.json`. Para
 * `/prod/billing/env`, isso é `.backups/prod/billing/env/2026-…json` — `env`
 * vira diretório aqui, enquanto no `.local-store` é `env.json`. São árvores
 * separadas e não colidem.
 *
 * **Arquivos com `0600`, diretórios com `0700`.** O conteúdo é valor de
 * parâmetro em texto claro, incluindo `SecureString` decriptado.
 *
 * Escrita atômica por temporário + rename, e por um motivo específico: o backup
 * é lido como prova de que a versão anterior está salva. Um arquivo truncado por
 * queda no meio da escrita seria pior que ausência, porque pareceria válido.
 */
export class LocalFileBackupAdapter implements BackupPort {
  private readonly rootDir: string;

  constructor(
    rootDir = './.backups',
    private readonly limits: RetentionLimits = retentionFromEnvironment(),
    private readonly now: () => Date = () => new Date(),
  ) {
    this.rootDir = resolve(rootDir);
  }

  async save(input: BackupInput): Promise<BackupResult> {
    const parameterName = parseParameterName(input.metadata.name);
    // Um único instante para o timestamp e para a poda: consultar o relógio duas
    // vezes faria a retenção julgar idade contra um "agora" diferente do que
    // acabou de ser gravado.
    const instant = this.now();
    const savedAt = instant.toISOString();
    const directory = await this.resolveDirectory(parameterName);

    const contents: BackupFileContents = {
      name: parameterName,
      version: input.metadata.version,
      type: input.metadata.type,
      tier: input.metadata.tier,
      keyId: input.metadata.keyId ?? null,
      savedAt,
      value: input.value,
    };

    const fileName = `${fileNameFor(savedAt)}.json`;
    const absolutePath = join(directory, fileName);

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

    return { entry, pruned: await this.prune(directory, instant) };
  }

  async list(parameterName: string): Promise<readonly BackupEntry[]> {
    const name = parseParameterName(parameterName);
    const directory = await this.resolveDirectory(name);

    return this.readEntries(directory);
  }

  /**
   * Diretório do parâmetro, exigindo caixa exata em cada nível.
   *
   * O APFS não distingue maiúsculas de minúsculas, mas o SSM sim. `/prod/env` e
   * `/Prod/env` são parâmetros diferentes na AWS e cairiam no **mesmo diretório
   * de backup** — o backup de um sobrescreveria o histórico do outro em
   * silêncio, que é o oposto do propósito. Falhar alto é a única saída.
   */
  private async resolveDirectory(parameterName: string): Promise<string> {
    const segments = nameSegments(parameterName);
    let current = this.rootDir;

    for (let index = 0; index < segments.length; index += 1) {
      const segment = segments[index] as string;

      let entries: string[];
      try {
        entries = await readdir(current);
      } catch {
        // Nível ainda não existe: o resto do caminho está livre.
        return join(this.rootDir, ...segments);
      }

      if (entries.includes(segment)) {
        current = join(current, segment);
        continue;
      }

      const variant = entries.find((entry) => entry.toLowerCase() === segment.toLowerCase());

      if (variant !== undefined) {
        const existing = `/${segments.slice(0, index).concat(variant).join('/')}`;
        throw new ParameterNameCollisionError(parameterName, `"${existing}"`);
      }

      return join(this.rootDir, ...segments);
    }

    return current;
  }

  /** Aplica a retenção no diretório do parâmetro. */
  private async prune(directory: string, instant: Date): Promise<readonly BackupEntry[]> {
    const entries = await this.readEntries(directory);
    const plan = planRetention(entries, this.limits, instant);

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

  /** Backups do diretório, do mais recente para o mais antigo. */
  private async readEntries(directory: string): Promise<readonly BackupEntry[]> {
    let fileNames: string[];

    try {
      fileNames = await readdir(directory);
    } catch {
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

      entries.push({
        savedAt,
        // A versão está dentro do arquivo, e ler todos só para listar seria
        // custo sem retorno: quem precisa da versão abre o arquivo.
        version: 0,
        absolutePath: join(directory, fileName),
      });
    }

    return entries.sort((left, right) => right.savedAt.localeCompare(left.savedAt));
  }

  private async writeAtomically(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp-${process.pid}`;

    await writeFile(temporary, contents, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
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
