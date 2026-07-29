import { describe, expect, it } from 'vitest';
import config from '../astro.config.mjs';

/**
 * Guarda de configuração.
 *
 * As três proteções abaixo vivem no `astro.config.mjs`, e config é justamente o
 * tipo de coisa que alguém mexe sem perceber a consequência. O teste existe
 * para que afrouxar qualquer uma delas quebre a suíte, em vez de passar
 * silenciosamente e só aparecer como segredo em disco meses depois.
 */

describe('sessão desligada', () => {
  it('declara um driver de sessão explicitamente', () => {
    // O @astrojs/node habilita sessão com storage em FILESYSTEM quando
    // `session.driver` está ausente. Só declarar já evita o padrão.
    expect(config.session).toBeDefined();
    expect(config.session?.driver).toBeDefined();
  });

  it('o driver não guarda nada em disco', () => {
    const driver = config.session?.driver;
    const entrypoint =
      typeof driver === 'string' ? driver : (driver as { entrypoint?: string } | undefined)?.entrypoint;

    expect(entrypoint).toBe('unstorage/drivers/null');
  });

  it('o driver não é nenhum dos que escrevem em disco', () => {
    const driver = config.session?.driver;
    const serialized = JSON.stringify(driver ?? {});

    for (const forbidden of ['fsLite', 'fs', 'filesystem', 'localstorage']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('bind em loopback', () => {
  // `server` pode ser objeto ou função no tipo do Astro; no nosso config é
  // objeto, e é isso que o teste verifica antes de olhar os campos.
  const server = typeof config.server === 'function' ? undefined : config.server;

  it('o server é declarado como objeto literal', () => {
    expect(server).toBeDefined();
  });

  it('o host é 127.0.0.1, nunca 0.0.0.0', () => {
    expect(server?.host).toBe('127.0.0.1');
    expect(server?.host).not.toBe('0.0.0.0');
  });

  it('allowedHosts só aceita loopback', () => {
    expect(server?.allowedHosts).toEqual(['127.0.0.1', 'localhost']);
  });
});

describe('CSRF', () => {
  it('checkOrigin está ligado', () => {
    // É o padrão do Astro 7, mas declarado para uma mudança de padrão não
    // afrouxar a proteção em silêncio.
    expect(config.security?.checkOrigin).toBe(true);
  });
});

describe('renderização no servidor', () => {
  it('output é server, porque toda chamada AWS acontece no backend', () => {
    expect(config.output).toBe('server');
  });
});
