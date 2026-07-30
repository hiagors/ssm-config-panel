import { describe, expect, it } from 'vitest';
import type { Parameter, ParameterMetadata } from '../domain/Parameter.js';
import { ParameterNotFoundError } from '../domain/errors.js';
import type {
  ListOptions,
  ParameterStorePort,
  PutOptions,
  PutResult,
} from '../infrastructure/store/ParameterStorePort.js';
import { GetParameterUseCase, inspectJson } from './GetParameterUseCase.js';

/** Port falso: o use case não conhece nem arquivo nem AWS. */
class FakeStore implements ParameterStorePort {
  constructor(private readonly parameters: Map<string, Parameter> = new Map()) {}

  static withParameter(overrides: Partial<ParameterMetadata>, value: string): FakeStore {
    const metadata: ParameterMetadata = {
      name: '/example/demo',
      type: 'String',
      tier: 'Standard',
      version: 1,
      ...overrides,
    };
    return new FakeStore(new Map([[metadata.name, { metadata, value }]]));
  }

  async list(_options?: ListOptions): Promise<ParameterMetadata[]> {
    return [...this.parameters.values()].map((p) => p.metadata);
  }

  async get(name: string): Promise<Parameter> {
    const found = this.parameters.get(name);
    if (found === undefined) {
      throw new ParameterNotFoundError(name);
    }
    return found;
  }

  async put(_name: string, _value: string, options: PutOptions): Promise<PutResult> {
    return { version: 1, tier: options.tier };
  }

}

describe('GetParameterUseCase', () => {
  it('marca JSON válido e não altera o valor', async () => {
    const raw = '{\n  "b": 1,\n  "a": 2\n}';
    const useCase = new GetParameterUseCase(FakeStore.withParameter({}, raw));

    const result = await useCase.execute('/example/demo');

    expect(result.isValidJson).toBe(true);
    expect(result.jsonError).toBeUndefined();
    expect(result.value).toBe(raw);
  });

  it('marca JSON inválido sem tentar consertar', async () => {
    const raw = '{"a": 1,';
    const useCase = new GetParameterUseCase(FakeStore.withParameter({}, raw));

    const result = await useCase.execute('/example/demo');

    expect(result.isValidJson).toBe(false);
    expect(result.jsonError).toBeDefined();
    expect(result.value).toBe(raw);
  });

  it('sinaliza SecureString para a UI mascarar', async () => {
    const useCase = new GetParameterUseCase(
      FakeStore.withParameter({ type: 'SecureString', keyId: 'alias/aws/ssm' }, '{"t":"x"}'),
    );

    expect((await useCase.execute('/example/demo')).isSecret).toBe(true);
  });

  it('não marca String como segredo', async () => {
    const useCase = new GetParameterUseCase(FakeStore.withParameter({ type: 'String' }, '{}'));

    expect((await useCase.execute('/example/demo')).isSecret).toBe(false);
  });

  it('calcula tamanho em bytes UTF-8, não em caracteres', async () => {
    // "ção" tem 3 caracteres e 5 bytes; o limite do SSM é em bytes.
    const useCase = new GetParameterUseCase(FakeStore.withParameter({}, '"ção"'));

    const result = await useCase.execute('/example/demo');

    expect(result.sizeInBytes).toBe(7);
  });

  it('reporta o limite do tier Standard', async () => {
    const useCase = new GetParameterUseCase(FakeStore.withParameter({ tier: 'Standard' }, '{}'));

    expect((await useCase.execute('/example/demo')).sizeLimitInBytes).toBe(4096);
  });

  it('reporta o limite do tier Advanced', async () => {
    const useCase = new GetParameterUseCase(FakeStore.withParameter({ tier: 'Advanced' }, '{}'));

    expect((await useCase.execute('/example/demo')).sizeLimitInBytes).toBe(8192);
  });

  it('propaga ParameterNotFoundError', async () => {
    const useCase = new GetParameterUseCase(new FakeStore());

    await expect(useCase.execute('/example/ausente')).rejects.toThrow(ParameterNotFoundError);
  });
});

describe('inspectJson', () => {
  it.each([
    ['objeto', '{"a":1}'],
    ['array', '[1,2,3]'],
    ['string', '"texto"'],
    ['número', '42'],
    ['null', 'null'],
    ['boolean', 'true'],
  ])('aceita %s como JSON válido', (_label, raw) => {
    expect(inspectJson(raw).isValidJson).toBe(true);
  });

  it.each([
    ['vazio', ''],
    ['objeto aberto', '{'],
    ['vírgula sobrando', '{"a":1,}'],
    ['texto solto', 'nao e json'],
  ])('rejeita %s', (_label, raw) => {
    expect(inspectJson(raw).isValidJson).toBe(false);
  });

  it('a descrição do erro não inclui o conteúdo', () => {
    const sentinel = 'SENTINEL-usecase-8c4b';

    const result = inspectJson(`{"token":"${sentinel}"`);

    expect(result.jsonError).not.toContain(sentinel);
  });
});
