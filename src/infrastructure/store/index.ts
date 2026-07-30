import {
  ProfileNotAuthenticatedError,
  ProfileNotUsableError,
  StoreUnavailableError,
} from '../../domain/errors.js';
import { LocalFileBackupAdapter } from '../backup/LocalFileBackupAdapter.js';
import type { BackupPort } from '../backup/BackupPort.js';
import { AwsSsoAdapter } from '../auth/AwsSsoAdapter.js';
import type { SsoAuthPort } from '../auth/SsoAuthPort.js';
import { AwsSsmStoreAdapter } from './AwsSsmStoreAdapter.js';
import { LocalFileStoreAdapter } from './LocalFileStoreAdapter.js';
import type { ParameterStorePort } from './ParameterStorePort.js';

/**
 * Composition root.
 *
 * Único ponto do sistema que escolhe implementação. Nada além deste arquivo
 * importa um adapter concreto — o resto depende só das portas.
 *
 * ── Por que o store é resolvido por request ─────────────────────────────────
 *
 * Na fase 1 isto era um singleton memoizado. Não serve mais: o profile vem
 * **explicitamente em cada request**, e o client do SSM é construído com as
 * credenciais daquele profile. Um singleton global significaria que trocar de
 * profile na UI não trocaria a identidade usada de fato — o pior tipo de bug
 * nesta ferramenta, porque a tela mostraria uma conta e a gravação iria para
 * outra.
 *
 * Cacheamos por `driver + profile + region`, para não recriar client a cada
 * request, mas nunca por "o último que foi usado".
 */

export const STORE_DRIVERS = ['local', 'aws'] as const;
export type StoreDriver = (typeof STORE_DRIVERS)[number];

const DEFAULT_DRIVER: StoreDriver = 'local';
const DEFAULT_LOCAL_STORE_DIR = './.local-store';
const DEFAULT_BACKUP_DIR = './.backups';

/** Contexto de uma operação: qual driver e, no caso da AWS, qual identidade. */
export interface StoreContext {
  readonly driver: StoreDriver;
  /** Obrigatório quando `driver` é `aws`; ignorado no `local`. */
  readonly profileName: string | undefined;
}

const storeCache = new Map<string, ParameterStorePort>();

let authAdapter: SsoAuthPort | undefined;
let backupAdapter: BackupPort | undefined;

/**
 * Rede de proteção compartilhada.
 *
 * Vale para os **dois** drivers. No `local` o store já é um arquivo, mas o
 * backup é o que dá rollback; no `aws` é o que o spec exige antes da primeira
 * escrita em conta real.
 */
export function getBackupPort(): BackupPort {
  backupAdapter ??= new LocalFileBackupAdapter(resolveBackupDir());
  return backupAdapter;
}

/** Só para teste: injeta uma rede de proteção falsa. */
export function setBackupPortForTesting(port: BackupPort | undefined): void {
  backupAdapter = port;
}

export function resolveBackupDir(): string {
  const raw = process.env['BACKUP_DIR']?.trim();
  return raw === undefined || raw === '' ? DEFAULT_BACKUP_DIR : raw;
}

/** Instância compartilhada da porta de autenticação. */
export function getSsoAuth(): SsoAuthPort {
  authAdapter ??= new AwsSsoAdapter();
  return authAdapter;
}

/** Só para teste: injeta uma porta de autenticação falsa. */
export function setSsoAuthForTesting(port: SsoAuthPort | undefined): void {
  authAdapter = port;
  storeCache.clear();
}

/**
 * Resolve o store para o contexto informado.
 *
 * Contra a AWS, valida o profile antes de construir qualquer client: profile
 * inexistente, sem SSO ou com sessão inválida falham aqui, com erro que a UI
 * sabe tratar — em vez de virar erro obscuro do SDK no meio de uma leitura.
 */
export async function resolveParameterStore(
  context: StoreContext,
): Promise<ParameterStorePort> {
  if (context.driver === 'local') {
    return cached('local', () => new LocalFileStoreAdapter(resolveLocalStoreDir()));
  }

  const profileName = context.profileName?.trim();

  if (profileName === undefined || profileName === '') {
    throw new ProfileNotUsableError(
      '(nenhum)',
      'nenhum profile foi informado, e o driver aws exige um',
    );
  }

  const auth = getSsoAuth();
  const profile = await auth.findProfile(profileName);

  if (profile === undefined) {
    throw new ProfileNotUsableError(profileName, 'não existe em ~/.aws/config');
  }

  if (!profile.selectable) {
    throw new ProfileNotUsableError(
      profileName,
      profile.blockedReason ?? 'não é um profile SSO',
    );
  }

  if (profile.sessionState !== 'valid') {
    // Não é erro de programação: token do SSO dura horas. A UI reage com
    // banner e botão de reautenticar, sem perder o rascunho.
    throw new ProfileNotAuthenticatedError(profileName);
  }

  const region = profile.region;

  if (region === undefined) {
    throw new ProfileNotUsableError(
      profileName,
      'não tem região definida. Adicione `region` ao profile em ~/.aws/config — a ferramenta ' +
        'não inventa região',
    );
  }

  return cached(`aws:${profileName}:${region}`, () => {
    return new AwsSsmStoreAdapter(profileName, region, auth.credentialsFor(profileName));
  });
}

function cached(key: string, create: () => ParameterStorePort): ParameterStorePort {
  const existing = storeCache.get(key);

  if (existing !== undefined) {
    return existing;
  }

  const created = create();
  storeCache.set(key, created);

  return created;
}

/**
 * Descarta os stores memoizados.
 *
 * Chamado depois de um login bem-sucedido: o client antigo carrega um provider
 * que já falhou, e reusá-lo manteria a sessão "expirada" mesmo depois de
 * reautenticar.
 */
export function resetParameterStores(): void {
  storeCache.clear();
}

export function resolveDriver(): StoreDriver {
  const raw = process.env['STORE_DRIVER']?.trim();

  if (raw === undefined || raw === '') {
    return DEFAULT_DRIVER;
  }

  const driver = STORE_DRIVERS.find((candidate) => candidate === raw);

  if (driver === undefined) {
    throw new StoreUnavailableError(
      `unknown STORE_DRIVER: ${raw}`,
      `STORE_DRIVER="${raw}" não é válido. Use "local" ou "aws".`,
    );
  }

  return driver;
}

export function resolveLocalStoreDir(): string {
  const raw = process.env['LOCAL_STORE_DIR']?.trim();
  return raw === undefined || raw === '' ? DEFAULT_LOCAL_STORE_DIR : raw;
}

/**
 * Profile pré-selecionado, quando `AWS_PROFILE` está no ambiente.
 *
 * Só uma sugestão para a UI marcar; não dispensa o profile vir por request.
 */
export function preselectedProfileName(): string | undefined {
  const raw = process.env['AWS_PROFILE']?.trim();
  return raw === undefined || raw === '' ? undefined : raw;
}
