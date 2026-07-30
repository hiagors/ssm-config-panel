/**
 * Proteção de requisição para servidor de loopback.
 *
 * **Loopback não é fronteira de segurança contra o browser.** Duas coisas que
 * `127.0.0.1` não impede:
 *
 * 1. **CSRF comum.** Qualquer página aberta em outra aba pode disparar
 *    requisição para `http://127.0.0.1:4321`. Sem checagem de origem, um
 *    `fetch` de um site qualquer conseguiria fazer `PUT` nos meus parâmetros.
 *    O browser bloqueia a *leitura* da resposta por CORS, mas a requisição
 *    acontece — e escrita não precisa de resposta para causar dano.
 *
 * 2. **DNS rebinding.** O atacante controla `evil.com`, cujo DNS resolve para
 *    `127.0.0.1`. O browser então acha que `evil.com` e o nosso servidor são a
 *    mesma origem, e a política de mesma origem deixa passar — inclusive a
 *    leitura da resposta, o que vaza valor de parâmetro decriptado. A defesa é
 *    o servidor recusar requisição cujo `Host` não seja um nome que ele
 *    reconhece: nesse ataque o `Host` chega como `evil.com`.
 *
 * O Astro tem `security.checkOrigin`, que cobre o item 1 para rotas não-GET.
 * Mantemos a checagem aqui de todo modo porque o item 2 ele não cobre, porque
 * queremos a mesma regra em dev e em produção, e porque a mensagem de erro
 * precisa ser nossa e já redigida.
 *
 * ── O que saiu, e por quê ───────────────────────────────────────────────────
 *
 * Havia também checagem de `Sec-Fetch-Site`, comparação de porta no `Host` e um
 * parser de `host:porta` escrito à mão para dar conta de `[::1]:4321`. Os três
 * saíram: `Sec-Fetch-Site` é redundante com a checagem de `Origin` que já
 * acontece logo abaixo; a porta do `Host` não protege de nada (a requisição já
 * chegou nesta porta, seja o que o cabeçalho disser); e o parsing manual virou
 * uma linha de `new URL`, que já entende IPv6 entre colchetes.
 */

import { ForbiddenOriginError } from '../../domain/errors.js';

/** Métodos que não alteram estado e por isso não exigem checagem de origem. */
const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Nomes de host aceitos. Endereço de loopback e o nome reservado dele. */
const ALLOWED_HOSTNAMES: ReadonlySet<string> = new Set(['127.0.0.1', 'localhost', '[::1]']);

export interface OriginPolicy {
  /** Porta em que o servidor escuta. Origem de outra porta é recusada. */
  readonly port: number;
}

export function originPolicyFromEnvironment(
  environment: Record<string, string | undefined> = process.env,
): OriginPolicy {
  const raw = environment['PORT']?.trim();
  const parsed = raw === undefined || raw === '' ? Number.NaN : Number(raw);

  return { port: Number.isInteger(parsed) && parsed > 0 ? parsed : 4321 };
}

/**
 * Verifica a requisição. Lança `ForbiddenOriginError` quando deve ser recusada.
 *
 * Aplicado a **toda** requisição no middleware, não só às de escrita: a
 * checagem de `Host` protege leitura também, e é na leitura que o valor
 * decriptado sai.
 */
export function assertRequestIsTrusted(request: Request, policy: OriginPolicy): void {
  assertHostIsTrusted(request);

  if (!SAFE_METHODS.has(request.method.toUpperCase())) {
    assertOriginIsTrusted(request, policy);
  }
}

/**
 * O `Host` precisa ser um nome de loopback.
 *
 * É esta checagem que quebra o DNS rebinding: o browser envia
 * `Host: evil.com`, e `evil.com` não está na lista.
 */
function assertHostIsTrusted(request: Request): void {
  const host = request.headers.get('host');

  if (host === null || host === '') {
    throw new ForbiddenOriginError('a requisição não informou o cabeçalho Host');
  }

  if (!ALLOWED_HOSTNAMES.has(hostnameOf(host))) {
    // Não interpolamos o hostname recebido para não refletir texto do atacante
    // de volta numa página de erro.
    throw new ForbiddenOriginError(
      'o cabeçalho Host não é um endereço de loopback conhecido (possível DNS rebinding)',
    );
  }
}

/**
 * Requisição que altera estado precisa vir da própria interface.
 *
 * `Origin` ausente é recusa, não permissão: browser sempre envia `Origin` em
 * requisição não-GET. Ausência significa cliente não-browser ou requisição
 * forjada, e nenhum dos dois tem por que gravar aqui.
 */
function assertOriginIsTrusted(request: Request, policy: OriginPolicy): void {
  const origin = request.headers.get('origin');

  if (origin === null || origin === '') {
    throw new ForbiddenOriginError(
      'requisição de escrita sem cabeçalho Origin; só a própria interface pode gravar',
    );
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ForbiddenOriginError('o cabeçalho Origin não é uma URL válida');
  }

  if (!ALLOWED_HOSTNAMES.has(parsed.hostname)) {
    throw new ForbiddenOriginError('a origem da requisição não é loopback');
  }

  const port = parsed.port === '' ? defaultPortFor(parsed.protocol) : Number(parsed.port);

  if (port !== policy.port) {
    throw new ForbiddenOriginError('a origem da requisição aponta para outra porta');
  }
}

/**
 * Hostname de um cabeçalho `Host`, sem a porta.
 *
 * `new URL` faz o trabalho, inclusive o `[::1]:4321` do IPv6 — e `URL.hostname`
 * devolve `[::1]` com os colchetes, que é a forma que está na allow-list.
 * `Host` inválido cai em string vazia, que não está na lista.
 */
function hostnameOf(host: string): string {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return '';
  }
}

function defaultPortFor(protocol: string): number {
  return protocol === 'https:' ? 443 : 80;
}
