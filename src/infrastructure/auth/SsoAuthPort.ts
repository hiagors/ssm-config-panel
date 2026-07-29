import type { AwsProfile } from '../../domain/AwsProfile.js';

/**
 * Contrato de autenticação.
 *
 * Existe para que trocar `AwsSsoAdapter` por um `SsoDeviceFlowAdapter` seja
 * substituição de implementação, não refatoração — o cenário do dia em que
 * isto rodar em container, onde não há navegador para abrir.
 *
 * **Credenciais nunca cruzam esta fronteira em texto.** `credentialsFor()`
 * devolve um provider opaco, consumido apenas pelo adapter do store, dentro de
 * `infrastructure/`. `application/` e `domain/` só veem `AwsProfile`, que não
 * carrega segredo algum.
 */
export interface SsoAuthPort {
  /**
   * Profiles da configuração compartilhada, com estado de sessão resolvido.
   *
   * Inclui os profiles não-SSO, marcados como tal: esconder não ajudaria, o
   * usuário precisa entender por que aquele profile não está disponível.
   */
  listProfiles(): Promise<AwsProfile[]>;

  /** Um profile específico, ou `undefined` se não existir na configuração. */
  findProfile(profileName: string): Promise<AwsProfile | undefined>;

  /**
   * Dispara `aws sso login --profile <name>`, que abre o navegador padrão.
   *
   * Resolve quando o comando termina. A UI faz polling em `findProfile` até a
   * sessão ficar válida.
   */
  login(profileName: string): Promise<LoginResult>;

  /**
   * Provider de credenciais para instanciar o client do SSM.
   *
   * O tipo é `unknown` de propósito: só o adapter do store sabe o que fazer
   * com ele, e nada em `application/` deve conseguir tocá-lo.
   */
  credentialsFor(profileName: string): unknown;
}

export interface LoginResult {
  readonly ok: boolean;
  /** Mensagem acionável quando falhou. Nunca inclui token nem saída crua. */
  readonly message: string | undefined;
}
