import type { BackupPort } from '../infrastructure/backup/BackupPort.js';
import { parseParameterName } from '../domain/parameterName.js';

/**
 * Histórico de backups de um parâmetro, e a leitura de um deles.
 *
 * É o que fecha o ciclo do backup. Guardar a versão anterior em disco só vira
 * **rollback** se existir um caminho de volta; sem isto, a única saída era abrir
 * `./.backups` no Finder e copiar JSON à mão — exatamente o fluxo que esta
 * ferramenta existe para eliminar.
 *
 * ── O que este use case deliberadamente não faz ─────────────────────────────
 *
 * Ele **não grava**. Restaurar não é uma escrita própria com regras próprias: é
 * carregar o valor antigo como rascunho e deixar o fluxo normal de gravação
 * acontecer — diff, confirmação explícita, recheque de versão no servidor e
 * backup da versão que está sendo substituída.
 *
 * Essa escolha é o que impede duas coisas ruins. Um "restaurar" que gravasse
 * direto pularia a confirmação (e "nunca salvar por acidente" é critério de
 * aceitação) e pularia o backup do estado atual — deixando o rollback sem
 * rollback. Como o caminho é o mesmo do save normal, restaurar a versão 6 sobre
 * a 8 gera o backup da 8 antes de gravar, e dá para desfazer o desfazer.
 */

export interface BackupSummary {
  /** ISO 8601. Identifica o backup na URL de restauração. */
  readonly savedAt: string;
  /** Versão do parâmetro preservada neste arquivo. */
  readonly version: number;
}

export interface RestoreCandidate {
  readonly savedAt: string;
  /** Versão de onde este valor veio. */
  readonly version: number;
  /**
   * Valor a carregar no editor.
   *
   * ATENÇÃO: pode ser `SecureString` decriptado. Vai para o rascunho no browser
   * pelo mesmo caminho do valor lido do store, e nunca para log nem para disco.
   */
  readonly value: string;
}

export class BackupHistoryUseCase {
  constructor(private readonly backup: BackupPort) {}

  /**
   * Backups disponíveis, do mais recente para o mais antigo.
   *
   * Sem valores: a tela de histórico é uma lista de datas e versões, e carregar
   * segredo para desenhar uma lista seria custo sem retorno.
   */
  async list(name: string): Promise<readonly BackupSummary[]> {
    const parameterName = parseParameterName(name);
    const entries = await this.backup.list(parameterName);

    return entries.map((entry) => ({ savedAt: entry.savedAt, version: entry.version }));
  }

  /**
   * Carrega um backup para virar rascunho no editor.
   *
   * @throws {BackupNotFoundError} quando a retenção já apagou o arquivo.
   */
  async read(name: string, savedAt: string): Promise<RestoreCandidate> {
    const parameterName = parseParameterName(name);
    const contents = await this.backup.read(parameterName, savedAt);

    return {
      savedAt: contents.savedAt === '' ? savedAt : contents.savedAt,
      version: contents.version,
      value: contents.value,
    };
  }
}
