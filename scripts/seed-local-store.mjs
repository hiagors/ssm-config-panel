#!/usr/bin/env node
//
// Cria um parâmetro de exemplo no store local.
//
// O prefixo é `/example` de propósito: não é nome de nenhum sistema real, e
// o spec proíbe inventar conta, região ou nome de parâmetro. O conteúdo
// cobre todos os tipos que o editor da Fase 2 precisa tratar — em especial
// `null` vs string vazia, int vs float e array heterogêneo.

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;

const rootDir = resolve(process.env['LOCAL_STORE_DIR']?.trim() || './.local-store');

const PARAMETER_NAME = '/example/demo/env';

/**
 * A ordem das chaves aqui é intencionalmente fora de ordem alfabética: o
 * teste de round-trip exige que a ordem original sobreviva.
 */
const value = {
  SERVICE_NAME: 'example-demo',
  PORT: 8080,
  TIMEOUT_SECONDS: 30.5,
  DEBUG: false,
  FEATURE_FLAG_ENABLED: true,
  OPTIONAL_UNSET: null,
  OPTIONAL_EMPTY: '',
  DATABASE: {
    host: 'localhost',
    port: 5432,
    ssl: true,
    pool: {
      min: 1,
      max: 10,
      idleTimeoutMillis: 30000,
    },
    replicas: [],
  },
  ALLOWED_ORIGINS: ['http://localhost:3000', 'http://127.0.0.1:4321'],
  MIXED_LIST: [1, 'dois', true, null, { nested: 'object' }, [1, 2]],
  RETRY_POLICY: {
    attempts: 3,
    backoff: {
      strategy: 'exponential',
      baseMillis: 200,
      factor: 2.0,
      jitter: true,
    },
  },
};

const metadata = {
  type: 'String',
  tier: 'Standard',
  keyId: null,
  version: 1,
  lastModifiedAt: new Date().toISOString(),
  description: 'Parâmetro de exemplo criado por scripts/seed-local-store.mjs',
};

const relativePath = PARAMETER_NAME.slice(1);
const valuePath = join(rootDir, `${relativePath}.json`);
const metaPath = join(rootDir, `${relativePath}.meta.json`);

await mkdir(dirname(valuePath), { recursive: true, mode: DIR_MODE });
await writeFile(valuePath, `${JSON.stringify(value, null, 2)}\n`, { mode: FILE_MODE });
await writeFile(metaPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: FILE_MODE });

console.log(`Criado ${PARAMETER_NAME}`);
console.log(`  valor:     ${valuePath}`);
console.log(`  metadados: ${metaPath}`);
console.log('');
console.log('Estes arquivos contêm valores em texto claro e ficam fora do git.');
console.log(`Abra em: http://127.0.0.1:${process.env['PORT'] ?? 4321}/parameters${PARAMETER_NAME}`);
