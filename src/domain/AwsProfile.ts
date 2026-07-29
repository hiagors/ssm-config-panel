/**
 * Modelo de profile da AWS, independente de SDK.
 *
 * A distinção que mais importa aqui é `kind`. `loadSharedConfigFiles()` lê
 * `~/.aws/config` **e** `~/.aws/credentials`, então profiles com chave de
 * acesso estática aparecem lado a lado com profiles SSO. Apresentá-los como
 * equivalentes é perigoso: selecionar por engano um profile de credencial
 * estática e editar produção sob uma identidade esquecida é erro sem sinal —
 * nada na tela indicaria que a operação foi com outra identidade.
 *
 * Por isso o modelo carrega o motivo do bloqueio, e não só um booleano: a UI
 * precisa explicar, não apenas desabilitar.
 */

export type ProfileKind =
  /** Tem `sso_session` ou `sso_start_url`. É o único que autenticamos. */
  | 'sso'
  /** Tem chave de acesso estática. Bloqueado de propósito. */
  | 'staticKeys'
  /** Nem SSO nem chave: só `region`/`output`. Não dá para operar. */
  | 'incomplete';

export type SsoSessionState =
  | 'valid'
  | 'expired'
  /** Nenhum token em cache para esta sessão SSO. */
  | 'neverAuthenticated'
  /** Não é profile SSO, então a pergunta não se aplica. */
  | 'notApplicable';

export interface AwsProfile {
  readonly name: string;
  readonly kind: ProfileKind;
  /** Conta do profile SSO, para a UI mostrar sob qual identidade se opera. */
  readonly accountId: string | undefined;
  readonly roleName: string | undefined;
  readonly region: string | undefined;
  readonly ssoStartUrl: string | undefined;
  /** Nome do bloco `[sso-session]`, quando é o formato novo. */
  readonly ssoSessionName: string | undefined;
  readonly sessionState: SsoSessionState;
  /** Quando a sessão expira. Só em `valid`. */
  readonly expiresAt: string | undefined;
  /** `true` quando o profile pode ser selecionado para operar. */
  readonly selectable: boolean;
  /** Por que não é selecionável. `undefined` quando é. */
  readonly blockedReason: string | undefined;
}

/** `true` quando dá para operar agora, sem passar por login. */
export function isReadyToUse(profile: AwsProfile): boolean {
  return profile.selectable && profile.sessionState === 'valid';
}

/** `true` quando o profile precisa (e pode) de `aws sso login`. */
export function needsLogin(profile: AwsProfile): boolean {
  return (
    profile.kind === 'sso' &&
    (profile.sessionState === 'expired' || profile.sessionState === 'neverAuthenticated')
  );
}

export function sessionStateLabel(state: SsoSessionState): string {
  switch (state) {
    case 'valid':
      return 'sessão válida';
    case 'expired':
      return 'sessão expirada';
    case 'neverAuthenticated':
      return 'nunca autenticado';
    case 'notApplicable':
      return 'sem SSO';
  }
}

export function profileKindLabel(kind: ProfileKind): string {
  switch (kind) {
    case 'sso':
      return 'SSO';
    case 'staticKeys':
      return 'chave estática';
    case 'incomplete':
      return 'incompleto';
  }
}
