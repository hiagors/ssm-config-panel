import { StoreDriverNotImplementedError, StoreUnavailableError } from '../../domain/errors.js';
import { LocalFileStoreAdapter } from './LocalFileStoreAdapter.js';
import type { ParameterStorePort } from './ParameterStorePort.js';

/**
 * Composition root.
 *
 * Único ponto do sistema que escolhe implementação. Nada além deste arquivo
 * importa um adapter concreto — o resto depende só de `ParameterStorePort`.
 */

export const STORE_DRIVERS = ['local', 'aws'] as const;
export type StoreDriver = (typeof STORE_DRIVERS)[number];

const DEFAULT_DRIVER: StoreDriver = 'local';
const DEFAULT_LOCAL_STORE_DIR = './.local-store';

let cached: ParameterStorePort | undefined;

/** Instância compartilhada do store, criada na primeira chamada. */
export function getParameterStore(): ParameterStorePort {
  cached ??= createParameterStore(resolveDriver(), resolveLocalStoreDir());
  return cached;
}

/** Só para teste: descarta a instância memoizada. */
export function resetParameterStore(): void {
  cached = undefined;
}

export function createParameterStore(driver: StoreDriver, localStoreDir: string): ParameterStorePort {
  switch (driver) {
    case 'local':
      return new LocalFileStoreAdapter(localStoreDir);
    case 'aws':
      // Fase 3. Falha explícita é melhor que cair no local sem avisar: o
      // usuário pediu a conta real e precisa saber que não foi lá.
      throw new StoreDriverNotImplementedError('aws');
  }
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
