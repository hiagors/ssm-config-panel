#!/usr/bin/env node
//
// Cria um parâmetro de exemplo no store local.
//
// O prefixo é `/example` de propósito: não é nome de nenhum sistema real, e
// o spec proíbe inventar conta, região ou nome de parâmetro. O conteúdo
// cobre todos os tipos que o editor da Fase 2 precisa tratar — em especial
// `null` vs string vazia, int vs float e array heterogêneo.

import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

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

/**
 * Envelope do store local: valor e metadados no mesmo arquivo plano.
 *
 * A forma tem de casar com `serialize()` em `LocalFileStoreAdapter.ts` — em
 * especial o `name`, que é o que o adapter compara para detectar colisão de
 * caixa. O nome do arquivo troca `/` por `#` e é minúsculo.
 */
const envelope = {
  name: PARAMETER_NAME,
  type: 'String',
  tier: 'Standard',
  keyId: null,
  version: 1,
  lastModifiedAt: new Date().toISOString(),
  description: 'Parâmetro de exemplo criado por scripts/seed-local-store.mjs',
  value: `${JSON.stringify(value, null, 2)}\n`,
};

const fileName = `${PARAMETER_NAME.slice(1).split('/').join('#').toLowerCase()}.json`;
const filePath = join(rootDir, fileName);

await mkdir(rootDir, { recursive: true, mode: DIR_MODE });
await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, { mode: FILE_MODE });

console.log(`Criado ${PARAMETER_NAME}`);
console.log(`  arquivo: ${filePath}`);
console.log('');
console.log('Estes arquivos contêm valores em texto claro e ficam fora do git.');
console.log(`Abra em: http://127.0.0.1:${process.env['PORT'] ?? 4321}/parameters${PARAMETER_NAME}`);
