import { describe, expect, it, vi } from 'vitest';
import type { Parameter, ParameterMetadata } from '../domain/Parameter.js';
import {
  BackupFailedError,
  ParameterNotFoundError,
  VersionMismatchError,
} from '../domain/errors.js';
import type {
  BackupInput,
  BackupPort,
  BackupResult,
} from '../infrastructure/backup/BackupPort.js';
import type {
  ListOptions,
  ParameterStorePort,
  PutOptions,
  PutResult,
} from '../infrastructure/store/ParameterStorePort.js';
import { SaveParameterUseCase, httpStatusForOutcome } from './SaveParameterUseCase.js';

const SENTINEL = 'SENTINEL-save-3c9d-DO-NOT-LEAK';

/**
 * Store falso que registra as chamadas de `put`.
 *
 * A asserção mais importante desta suíte é negativa: em conflito e em
 * inexistência, `put` **não é chamado**. Verificar só o desfecho retornado
 * deixaria passar uma implementação que grava e depois avisa.
 */
class FakeStore implements ParameterStorePort {
  readonly putCalls: { name: string; value: string; options: PutOptions }[] = [];
  /** Chamadas de `get`, para checar que houve re-leitura antes de gravar. */
  getCalls = 0;

  constructor(private parameter: Parameter | undefined) {}

  static with(metadata: Partial<ParameterMetadata>, value: string): FakeStore {
    return new FakeStore({
      metadata: {
        name: '/example/demo',
        type: 'String',
        tier: 'Standard',
        version: 3,
        ...metadata,
      },
      value,
    });
  }

  static empty(): FakeStore {
    return new FakeStore(undefined);
  }

  async list(_options?: ListOptions): Promise<ParameterMetadata[]> {
    return this.parameter === undefined ? [] : [this.parameter.metadata];
  }

  async get(name: string): Promise<Parameter> {
    this.getCalls += 1;
    if (this.parameter === undefined) {
      throw new ParameterNotFoundError(name);
    }
    return this.parameter;
  }

  async put(name: string, value: string, options: PutOptions): Promise<PutResult> {
    this.putCalls.push({ name, value, options });

    const current = this.parameter?.metadata.version ?? 0;

    if (options.expectedVersion !== current) {
      throw new VersionMismatchError(name, options.expectedVersion, current);
    }

    const metadata: ParameterMetadata = {
      name,
      type: options.type,
      tier: options.tier,
      keyId: options.keyId,
      version: current + 1,
    };
    this.parameter = { metadata, value };

    return { version: metadata.version, tier: options.tier };
  }

  async history(name: string): Promise<Parameter[]> {
    return [await this.get(name)];
  }
}

/**
 * Rede de proteção falsa.
 *
 * Registra as chamadas porque a asserção que importa é de **ordem**: o backup
 * tem de acontecer antes do `put`, e não acontecer nada quando o save aborta.
 */
class FakeBackup implements BackupPort {
  readonly saved: BackupInput[] = [];
  shouldFail = false;

  async save(input: BackupInput): Promise<BackupResult> {
    if (this.shouldFail) {
      throw new BackupFailedError(input.metadata.name, 'disco cheio (simulado)');
    }

    this.saved.push(input);

    return {
      entry: { savedAt: '2026-07-29T12:00:00.000Z', version: input.metadata.version, absolutePath: '/tmp/fake' },
      pruned: [],
    };
  }

  async list(): Promise<readonly []> {
    return [];
  }
}

describe('SaveParameterUseCase — caminho felizes', () => {
  it('grava quando a versão bate', async () => {
    const store = FakeStore.with({ version: 3 }, '{"a":1}');
    const useCase = new SaveParameterUseCase(store, new FakeBackup());

    const result = await useCase.execute({
      name: '/example/demo',
      value: '{"a":2}',
      expectedVersion: 3,
    });

    expect(result).toEqual({ outcome: 'saved', version: 4, tier: 'Standard' });
    expect(store.putCalls).toHaveLength(1);
  });

  it('relê antes de gravar', async () => {
    const store = FakeStore.with({ version: 1 }, '{"a":1}');

    await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"a":2}',
      expectedVersion: 1,
    });

    expect(store.getCalls).toBeGreaterThanOrEqual(1);
  });

  it('preserva Type, Tier e KeyId do original', async () => {
    // O cliente não escolhe metadado — nem por engano, nem de propósito.
    const store = FakeStore.with(
      { type: 'SecureString', tier: 'Advanced', keyId: 'alias/minha-chave', version: 5 },
      '{"a":1}',
    );

    await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"a":2}',
      expectedVersion: 5,
    });

    expect(store.putCalls[0]?.options).toMatchObject({
      type: 'SecureString',
      tier: 'Advanced',
      keyId: 'alias/minha-chave',
    });
  });

  it('repassa expectedVersion para o adapter checar de novo', async () => {
    const store = FakeStore.with({ version: 7 }, '{"a":1}');

    await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"a":2}',
      expectedVersion: 7,
    });

    expect(store.putCalls[0]?.options.expectedVersion).toBe(7);
  });

  it('grava mudança só de formatação', async () => {
    const store = FakeStore.with({ version: 1 }, '{"a":1}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{ "a" : 1 }',
      expectedVersion: 1,
    });

    expect(result.outcome).toBe('saved');
  });
});

describe('SaveParameterUseCase — lost update', () => {
  it('aborta quando a versão divergiu e NÃO grava', async () => {
    const store = FakeStore.with({ version: 5 }, '{"deles":true}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"meu":true}',
      expectedVersion: 3,
    });

    expect(result.outcome).toBe('conflict');
    // A asserção que importa: nada foi escrito.
    expect(store.putCalls).toEqual([]);
  });

  it('o conflito carrega o valor atual, que o diff de três vias precisa', async () => {
    const store = FakeStore.with({ version: 5 }, '{"deles":true}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"meu":true}',
      expectedVersion: 3,
    });

    expect(result).toMatchObject({
      outcome: 'conflict',
      expectedVersion: 3,
      currentVersion: 5,
      currentValue: '{"deles":true}',
    });
  });

  it('o conflito carrega os metadados atuais', async () => {
    const store = FakeStore.with({ version: 5, type: 'SecureString', keyId: 'alias/k' }, '{}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"meu":true}',
      expectedVersion: 3,
    });

    expect(result.outcome === 'conflict' && result.currentMetadata.type).toBe('SecureString');
  });

  it('versão mais nova que a esperada também aborta', async () => {
    const store = FakeStore.with({ version: 2 }, '{}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"x":1}',
      expectedVersion: 9,
    });

    expect(result.outcome).toBe('conflict');
    expect(store.putCalls).toEqual([]);
  });

  it('corrida entre o re-read e a gravação vira conflito, não exceção', async () => {
    // Simula alguém gravando exatamente na janela entre o passo 3 e o 4. O
    // adapter pega e o use case traduz.
    const store = FakeStore.with({ version: 4 }, '{"deles":true}');
    const originalPut = store.put.bind(store);

    vi.spyOn(store, 'put').mockImplementationOnce(async (name, _value, options) => {
      throw new VersionMismatchError(name, options.expectedVersion, 5);
    });

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"meu":true}',
      expectedVersion: 4,
    });

    expect(result.outcome).toBe('conflict');
    void originalPut;
    vi.restoreAllMocks();
  });
});

describe('SaveParameterUseCase — nunca cria', () => {
  it('parâmetro inexistente devolve notFound e NÃO grava', async () => {
    // `PutParameter` com `Overwrite: true` criaria. Aqui não.
    const store = FakeStore.empty();

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/ausente',
      value: '{"a":1}',
      expectedVersion: 1,
    });

    expect(result).toEqual({ outcome: 'notFound', name: '/example/ausente' });
    expect(store.putCalls).toEqual([]);
  });

  it('nem com expectedVersion alto', async () => {
    const store = FakeStore.empty();

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/ausente',
      value: '{"a":1}',
      expectedVersion: 999,
    });

    expect(result.outcome).toBe('notFound');
    expect(store.putCalls).toEqual([]);
  });
});

describe('SaveParameterUseCase — revalida no servidor', () => {
  it('recusa JSON inválido', async () => {
    const store = FakeStore.with({ version: 1 }, '{"a":1}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"a":',
      expectedVersion: 1,
    });

    expect(result.outcome).toBe('invalid');
    expect(store.putCalls).toEqual([]);
  });

  it('recusa chave duplicada, mesmo que o cliente tenha deixado passar', async () => {
    const store = FakeStore.with({ version: 1 }, '{"a":1}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"a":1,"a":2}',
      expectedVersion: 1,
    });

    expect(result.outcome === 'invalid' && result.issues.map((issue) => issue.code)).toContain(
      'DUPLICATE_KEY',
    );
    expect(store.putCalls).toEqual([]);
  });

  it('recusa chave vazia', async () => {
    const store = FakeStore.with({ version: 1 }, '{"a":1}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"":1}',
      expectedVersion: 1,
    });

    expect(result.outcome).toBe('invalid');
    expect(store.putCalls).toEqual([]);
  });

  it('usa o tier real do parâmetro, não um informado pelo cliente', async () => {
    // Payload de 5 KB: passa em Advanced, estoura em Standard.
    const big = `{"a":"${'x'.repeat(5000)}"}`;

    const standard = FakeStore.with({ version: 1, tier: 'Standard' }, '{}');
    const advanced = FakeStore.with({ version: 1, tier: 'Advanced' }, '{}');
    const input = { name: '/example/demo', value: big, expectedVersion: 1 };

    expect((await new SaveParameterUseCase(standard, new FakeBackup()).execute(input)).outcome).toBe('invalid');
    expect((await new SaveParameterUseCase(advanced, new FakeBackup()).execute(input)).outcome).toBe('saved');
  });

  it('aviso de tamanho não bloqueia a gravação', async () => {
    const store = FakeStore.with({ version: 1, tier: 'Standard' }, '{}');
    const nearLimit = `{"a":"${'x'.repeat(Math.floor(4096 * 0.92))}"}`;

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: nearLimit,
      expectedVersion: 1,
    });

    expect(result.outcome).toBe('saved');
  });
});

describe('SaveParameterUseCase — nada vaza valor', () => {
  it('o desfecho invalid não repassa o conteúdo', async () => {
    const store = FakeStore.with({ version: 1 }, '{}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: `{"token":"${SENTINEL}"`,
      expectedVersion: 1,
    });

    expect(result.outcome).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('o desfecho invalid de chave duplicada não repassa o valor', async () => {
    const store = FakeStore.with({ version: 1 }, '{}');

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: `{"a":"${SENTINEL}","a":"${SENTINEL}"}`,
      expectedVersion: 1,
    });

    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it('o conflito CARREGA o valor atual — de propósito', async () => {
    // Não é vazamento: é o payload que o diff de três vias precisa, servido em
    // loopback com `no-store`. A garantia é que ele não passa pelo error
    // mapper, e que o valor nunca entra em objeto de erro nem em log. Este
    // teste documenta a intenção para ninguém "consertar" isso depois.
    const store = FakeStore.with({ version: 5 }, `{"segredo":"${SENTINEL}"}`);

    const result = await new SaveParameterUseCase(store, new FakeBackup()).execute({
      name: '/example/demo',
      value: '{"meu":true}',
      expectedVersion: 3,
    });

    expect(result.outcome === 'conflict' && result.currentValue).toContain(SENTINEL);
  });
});

describe('httpStatusForOutcome', () => {
  it.each([
    ['saved', 200],
    ['invalid', 422],
    ['notFound', 404],
    ['conflict', 409],
  ] as const)('%s -> %i', (outcome, status) => {
    expect(httpStatusForOutcome(outcome)).toBe(status);
  });
});

describe('SaveParameterUseCase — a rede de proteção', () => {
  it('faz backup ANTES de gravar', async () => {
    // A ordem é o ponto. Backup depois do put não protege de nada.
    const store = FakeStore.with({ version: 3 }, '{"anterior":true}');
    const backup = new FakeBackup();
    const order: string[] = [];

    const originalPut = store.put.bind(store);
    vi.spyOn(store, 'put').mockImplementation(async (...args) => {
      order.push('put');
      return originalPut(...args);
    });
    const originalSave = backup.save.bind(backup);
    vi.spyOn(backup, 'save').mockImplementation(async (input) => {
      order.push('backup');
      return originalSave(input);
    });

    await new SaveParameterUseCase(store, backup).execute({
      name: '/example/demo',
      value: '{"novo":true}',
      expectedVersion: 3,
    });

    expect(order).toEqual(['backup', 'put']);
    vi.restoreAllMocks();
  });

  it('o backup guarda a versão ANTERIOR, não a nova', async () => {
    // Guardar o valor novo seria inútil: ele já está no store.
    const store = FakeStore.with({ version: 3 }, '{"anterior":true}');
    const backup = new FakeBackup();

    await new SaveParameterUseCase(store, backup).execute({
      name: '/example/demo',
      value: '{"novo":true}',
      expectedVersion: 3,
    });

    expect(backup.saved).toHaveLength(1);
    expect(backup.saved[0]?.value).toBe('{"anterior":true}');
    expect(backup.saved[0]?.metadata.version).toBe(3);
  });

  it('o backup preserva os metadados necessários para rollback', async () => {
    const store = FakeStore.with(
      { version: 2, type: 'SecureString', tier: 'Advanced', keyId: 'alias/k' },
      '{"segredo":true}',
    );
    const backup = new FakeBackup();

    await new SaveParameterUseCase(store, backup).execute({
      name: '/example/demo',
      value: '{}',
      expectedVersion: 2,
    });

    expect(backup.saved[0]?.metadata).toMatchObject({
      type: 'SecureString',
      tier: 'Advanced',
      keyId: 'alias/k',
    });
  });

  it('falha de backup ABORTA a gravação', async () => {
    // Sem rede de proteção, não grava. Não é aviso, é bloqueio.
    const store = FakeStore.with({ version: 3 }, '{"anterior":true}');
    const backup = new FakeBackup();
    backup.shouldFail = true;

    await expect(
      new SaveParameterUseCase(store, backup).execute({
        name: '/example/demo',
        value: '{"novo":true}',
        expectedVersion: 3,
      }),
    ).rejects.toBeInstanceOf(BackupFailedError);

    expect(store.putCalls).toEqual([]);
  });

  it('a mensagem de falha de backup diz que nada foi alterado', async () => {
    const store = FakeStore.with({ version: 1 }, '{}');
    const backup = new FakeBackup();
    backup.shouldFail = true;

    await expect(
      new SaveParameterUseCase(store, backup).execute({
        name: '/example/demo',
        value: '{"x":1}',
        expectedVersion: 1,
      }),
    ).rejects.toMatchObject({
      code: 'BACKUP_FAILED',
      publicMessage: expect.stringContaining('Nada foi alterado'),
    });
  });

  it('conflito não gera backup: nada vai ser sobrescrito', async () => {
    const store = FakeStore.with({ version: 5 }, '{}');
    const backup = new FakeBackup();

    await new SaveParameterUseCase(store, backup).execute({
      name: '/example/demo',
      value: '{"x":1}',
      expectedVersion: 3,
    });

    expect(backup.saved).toEqual([]);
  });

  it('parâmetro inexistente não gera backup', async () => {
    const backup = new FakeBackup();

    await new SaveParameterUseCase(FakeStore.empty(), backup).execute({
      name: '/example/ausente',
      value: '{}',
      expectedVersion: 1,
    });

    expect(backup.saved).toEqual([]);
  });

  it('valor inválido não gera backup', async () => {
    const backup = new FakeBackup();

    await new SaveParameterUseCase(FakeStore.with({ version: 1 }, '{}'), backup).execute({
      name: '/example/demo',
      value: '{"a":',
      expectedVersion: 1,
    });

    expect(backup.saved).toEqual([]);
  });
});
