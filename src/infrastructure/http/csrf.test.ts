import { describe, expect, it } from 'vitest';
import { ForbiddenOriginError } from '../../domain/errors.js';
import {
  assertRequestIsTrusted,
  checkRequestIsTrusted,
  originPolicyFromEnvironment,
} from './csrf.js';

const POLICY = { port: 4321 };

function request(
  method: string,
  headers: Record<string, string>,
  url = 'http://127.0.0.1:4321/api/parameters/example/demo',
): Request {
  return new Request(url, { method, headers, ...(method === 'PUT' ? { body: '{}' } : {}) });
}

describe('leitura em loopback é aceita', () => {
  it.each(['127.0.0.1:4321', 'localhost:4321', '[::1]:4321'])('aceita Host %s', (host) => {
    expect(() => assertRequestIsTrusted(request('GET', { host }), POLICY)).not.toThrow();
  });

  it('aceita Host sem porta', () => {
    expect(() => assertRequestIsTrusted(request('GET', { host: '127.0.0.1' }), POLICY)).not.toThrow();
  });

  it('GET não exige Origin', () => {
    expect(() =>
      assertRequestIsTrusted(request('GET', { host: '127.0.0.1:4321' }), POLICY),
    ).not.toThrow();
  });
});

describe('DNS rebinding', () => {
  it('recusa Host de domínio externo, mesmo em requisição de leitura', () => {
    // O ataque: evil.com resolve para 127.0.0.1, então o browser trata como
    // mesma origem e deixa LER a resposta — que carrega valor decriptado. A
    // única pista no servidor é o Host.
    expect(() => assertRequestIsTrusted(request('GET', { host: 'evil.com' }), POLICY)).toThrow(
      ForbiddenOriginError,
    );
  });

  it.each(['evil.com', 'evil.com:4321', 'sub.127.0.0.1.evil.com', '127.0.0.1.evil.com'])(
    'recusa Host %s',
    (host) => {
      expect(() => assertRequestIsTrusted(request('GET', { host }), POLICY)).toThrow(
        ForbiddenOriginError,
      );
    },
  );

  it('recusa Host ausente', () => {
    const bare = new Request('http://127.0.0.1:4321/');
    bare.headers.delete('host');

    expect(() => assertRequestIsTrusted(bare, POLICY)).toThrow(ForbiddenOriginError);
  });

  it('recusa Host de outra porta', () => {
    expect(() =>
      assertRequestIsTrusted(request('GET', { host: '127.0.0.1:9999' }), POLICY),
    ).toThrow(ForbiddenOriginError);
  });

  it('a mensagem não reflete o Host recebido', () => {
    // Não devolvemos texto do atacante numa página de erro.
    const result = checkRequestIsTrusted(
      request('GET', { host: 'evil-<script>-com' }),
      POLICY,
    );

    expect(result.trusted).toBe(false);
    expect(result.trusted === false && result.reason).not.toContain('evil');
    expect(result.trusted === false && result.reason).toContain('DNS rebinding');
  });
});

describe('CSRF em requisição de escrita', () => {
  it('aceita PUT com Origin da própria interface', () => {
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:4321' }),
        POLICY,
      ),
    ).not.toThrow();
  });

  it('aceita PUT vindo de localhost', () => {
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', { host: 'localhost:4321', origin: 'http://localhost:4321' }),
        POLICY,
      ),
    ).not.toThrow();
  });

  it('recusa PUT sem Origin', () => {
    // Browser sempre manda Origin em requisição não-GET. Ausência é cliente
    // não-browser ou requisição forjada, e nenhum dos dois tem por que gravar.
    expect(() =>
      assertRequestIsTrusted(request('PUT', { host: '127.0.0.1:4321' }), POLICY),
    ).toThrow(ForbiddenOriginError);
  });

  it('recusa PUT com Origin de outro site', () => {
    // O cenário de CSRF: uma aba em evil.com dispara fetch para 127.0.0.1. O
    // CORS bloqueia a leitura da resposta, mas a escrita já teria acontecido.
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', { host: '127.0.0.1:4321', origin: 'https://evil.com' }),
        POLICY,
      ),
    ).toThrow(ForbiddenOriginError);
  });

  it('recusa PUT com Origin de outra porta em loopback', () => {
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', { host: '127.0.0.1:4321', origin: 'http://127.0.0.1:3000' }),
        POLICY,
      ),
    ).toThrow(ForbiddenOriginError);
  });

  it('recusa PUT com Origin malformado', () => {
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', { host: '127.0.0.1:4321', origin: 'nao-e-url' }),
        POLICY,
      ),
    ).toThrow(ForbiddenOriginError);
  });

  it('recusa quando Sec-Fetch-Site diz cross-site', () => {
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', {
          host: '127.0.0.1:4321',
          origin: 'http://127.0.0.1:4321',
          'sec-fetch-site': 'cross-site',
        }),
        POLICY,
      ),
    ).toThrow(ForbiddenOriginError);
  });

  it('aceita Sec-Fetch-Site same-origin', () => {
    expect(() =>
      assertRequestIsTrusted(
        request('PUT', {
          host: '127.0.0.1:4321',
          origin: 'http://127.0.0.1:4321',
          'sec-fetch-site': 'same-origin',
        }),
        POLICY,
      ),
    ).not.toThrow();
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s exige Origin', (method) => {
    expect(() =>
      assertRequestIsTrusted(request(method, { host: '127.0.0.1:4321' }), POLICY),
    ).toThrow(ForbiddenOriginError);
  });

  it.each(['GET', 'HEAD'])('%s não exige Origin', (method) => {
    expect(() =>
      assertRequestIsTrusted(request(method, { host: '127.0.0.1:4321' }), POLICY),
    ).not.toThrow();
  });
});

describe('originPolicyFromEnvironment', () => {
  it('usa 4321 por padrão', () => {
    expect(originPolicyFromEnvironment({}).port).toBe(4321);
  });

  it('lê PORT', () => {
    expect(originPolicyFromEnvironment({ PORT: '8080' }).port).toBe(8080);
  });

  it('ignora PORT inválido em vez de aceitar qualquer porta', () => {
    for (const raw of ['', '  ', 'abc', '-1', '0', '1.5']) {
      expect(originPolicyFromEnvironment({ PORT: raw }).port).toBe(4321);
    }
  });
});

describe('erro de origem é redigido e acionável', () => {
  it('tem status 403 e código estável', () => {
    try {
      assertRequestIsTrusted(request('GET', { host: 'evil.com' }), POLICY);
      throw new Error('esperava exceção');
    } catch (error) {
      expect(error).toBeInstanceOf(ForbiddenOriginError);
      expect(error).toMatchObject({ code: 'FORBIDDEN_ORIGIN', httpStatus: 403 });
    }
  });

  it('a mensagem pública diz o que fazer', () => {
    try {
      assertRequestIsTrusted(request('GET', { host: 'evil.com' }), POLICY);
      throw new Error('esperava exceção');
    } catch (error) {
      expect(error instanceof ForbiddenOriginError && error.publicMessage).toContain('loopback');
    }
  });
});
