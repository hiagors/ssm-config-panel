/**
 * Erros de domínio.
 *
 * Regra central de segurança: a mensagem de erro que chega ao usuário é
 * SEMPRE a `publicMessage` declarada aqui. Nada mais atravessa a fronteira
 * HTTP — nem `error.message` de bibliotecas, nem `cause`, nem stack trace.
 *
 * O motivo é concreto: `JSON.parse` embute um trecho do texto de entrada na
 * mensagem de erro. Se esse texto for um `SecureString` decriptado, repassar
 * a mensagem original vaza o segredo para o browser e para o log.
 *
 * Ver a implementação em `src/pages/api/_http.ts`.
 */

/** Código estável, seguro para exibir e para o cliente ramificar em cima. */
export type AppErrorCode =
  | 'INVALID_PARAMETER_NAME'
  | 'INVALID_REQUEST_BODY'
  | 'PARAMETER_NOT_FOUND'
  | 'PARAMETER_NAME_COLLISION'
  | 'PARAMETER_ALREADY_EXISTS'
  | 'VERSION_MISMATCH'
  | 'FORBIDDEN_ORIGIN'
  | 'PROFILE_NOT_USABLE'
  | 'PROFILE_NOT_AUTHENTICATED'
  | 'SSO_LOGIN_FAILED'
  | 'AWS_ACCESS_DENIED'
  | 'AWS_REQUEST_FAILED'
  | 'WRITE_NOT_ENABLED'
  | 'BACKUP_FAILED'
  | 'STORE_UNAVAILABLE'
  | 'STORE_DRIVER_NOT_IMPLEMENTED'
  | 'INTERNAL_ERROR';

/**
 * Base de todo erro que pode ser exibido.
 *
 * `publicMessage` é curada à mão e nunca interpolada com valor de parâmetro.
 * É permitido interpolar o *name* do parâmetro: names não são segredo.
 */
export abstract class AppError extends Error {
  abstract readonly code: AppErrorCode;
  abstract readonly httpStatus: number;

  /** Texto seguro para o usuário. Deve ser acionável, não um stack trace. */
  abstract readonly publicMessage: string;

  constructor(internalMessage: string) {
    super(internalMessage);
    this.name = new.target.name;
  }
}

export class InvalidParameterNameError extends AppError {
  readonly code = 'INVALID_PARAMETER_NAME' as const;
  readonly httpStatus = 400;
  readonly publicMessage: string;

  constructor(readonly reason: string) {
    super(`invalid parameter name: ${reason}`);
    this.publicMessage = `Name de parâmetro inválido: ${reason}`;
  }
}

/**
 * Corpo de requisição malformado.
 *
 * Separado de `InvalidParameterNameError` porque a causa é outra: o name pode
 * estar perfeito e o corpo errado. Reusar o erro do name produziria a mensagem
 * enganosa "Name de parâmetro inválido: o campo expectedVersion...".
 *
 * A mensagem nunca inclui o corpo recebido — ele é o valor do parâmetro.
 * Apenas qual campo está errado.
 */
export class InvalidRequestBodyError extends AppError {
  readonly code = 'INVALID_REQUEST_BODY' as const;
  readonly httpStatus = 400;
  readonly publicMessage: string;

  constructor(readonly reason: string) {
    super(`invalid request body: ${reason}`);
    this.publicMessage = `Corpo da requisição inválido: ${reason}`;
  }
}

export class ParameterNotFoundError extends AppError {
  readonly code = 'PARAMETER_NOT_FOUND' as const;
  readonly httpStatus = 404;
  readonly publicMessage: string;

  constructor(readonly parameterName: string) {
    super(`parameter not found: ${parameterName}`);
    this.publicMessage = `Parâmetro não encontrado: ${parameterName}`;
  }
}

/**
 * Duas grafias do mesmo name colidiriam no disco.
 *
 * O APFS do macOS é case-insensitive por padrão, então `/prod/env` e
 * `/Prod/env` — que no SSM são parâmetros distintos — apontariam para o
 * mesmo arquivo. Falhar alto é a única saída correta: silenciosamente
 * devolver ou sobrescrever o parâmetro errado seria pior.
 */
export class ParameterNameCollisionError extends AppError {
  readonly code = 'PARAMETER_NAME_COLLISION' as const;
  readonly httpStatus = 409;
  readonly publicMessage: string;

  /**
   * @param existingName descrição do que já está no disco, já entre aspas —
   *        pode ser o name completo ou um prefixo de diretório.
   */
  constructor(
    readonly requestedName: string,
    readonly existingName: string,
  ) {
    super(`case-insensitive collision: ${requestedName} vs ${existingName}`);
    this.publicMessage =
      `O name "${requestedName}" colide com ${existingName}, que já existe no store local. ` +
      `O sistema de arquivos do macOS não distingue maiúsculas de minúsculas, então os dois ` +
      `não podem coexistir em ./.local-store. Renomeie um deles ou use o driver "aws".`;
  }
}

/**
 * A versão no store não é a que o chamador esperava.
 *
 * Lançado pelo adapter, o mais perto possível da escrita. O use case de save
 * traduz isso em resultado de conflito — não em erro para o cliente — porque o
 * diff de três vias precisa do valor atual, e o error mapper redige por
 * padrão. Ver `SaveParameterUseCase`.
 */
export class VersionMismatchError extends AppError {
  readonly code = 'VERSION_MISMATCH' as const;
  readonly httpStatus = 409;
  readonly publicMessage: string;

  constructor(
    readonly parameterName: string,
    readonly expectedVersion: number,
    readonly currentVersion: number,
  ) {
    super(
      `version mismatch on ${parameterName}: expected ${expectedVersion}, found ${currentVersion}`,
    );
    this.publicMessage =
      `O parâmetro ${parameterName} está na versão ${currentVersion}, mas a edição partiu da ` +
      `versão ${expectedVersion}. Alguém gravou nesse intervalo. Nada foi sobrescrito.`;
  }
}

/**
 * Tentativa de criar um parâmetro que já existe.
 *
 * Acontece quando `expectedVersion` é 0 — o contrato de "espero que não exista"
 * — e o parâmetro está lá.
 */
export class ParameterAlreadyExistsError extends AppError {
  readonly code = 'PARAMETER_ALREADY_EXISTS' as const;
  readonly httpStatus = 409;
  readonly publicMessage: string;

  constructor(
    readonly parameterName: string,
    readonly currentVersion: number,
  ) {
    super(`parameter already exists: ${parameterName} at version ${currentVersion}`);
    this.publicMessage =
      `O parâmetro ${parameterName} já existe, na versão ${currentVersion}. ` +
      `A gravação foi abortada para não sobrescrever.`;
  }
}

/**
 * Requisição rejeitada por origem ou Host não confiável.
 *
 * O servidor escuta em loopback, mas loopback não é fronteira de segurança
 * contra o browser: qualquer página web pode fazer requisição para
 * `127.0.0.1`, e um domínio do atacante pode resolver para `127.0.0.1`
 * (DNS rebinding) para fazer o Host parecer legítimo. Ver
 * `infrastructure/http/csrf.ts`.
 */
export class ForbiddenOriginError extends AppError {
  readonly code = 'FORBIDDEN_ORIGIN' as const;
  readonly httpStatus = 403;
  readonly publicMessage: string;

  constructor(readonly reason: string) {
    super(`forbidden origin: ${reason}`);
    this.publicMessage =
      `Requisição rejeitada: ${reason}. Esta ferramenta só aceita requisições vindas dela ` +
      `mesma, em 127.0.0.1 ou localhost. Abra a interface pelo endereço de loopback.`;
  }
}

/** Profile selecionado não serve para operar: sem SSO, ou inexistente. */
export class ProfileNotUsableError extends AppError {
  readonly code = 'PROFILE_NOT_USABLE' as const;
  readonly httpStatus = 400;
  readonly publicMessage: string;

  constructor(
    readonly profileName: string,
    readonly reason: string,
  ) {
    super(`profile not usable: ${profileName}: ${reason}`);
    this.publicMessage = `O profile "${profileName}" não pode ser usado: ${reason}`;
  }
}

/**
 * Sessão SSO ausente ou expirada.
 *
 * Estado de primeira classe, não erro de programação: o token do SSO dura
 * poucas horas, e expirar no meio da edição é rotina. O código estável permite
 * a UI reagir com banner e botão de reautenticar, em vez de tela de erro.
 */
export class ProfileNotAuthenticatedError extends AppError {
  readonly code = 'PROFILE_NOT_AUTHENTICATED' as const;
  readonly httpStatus = 401;
  readonly publicMessage: string;

  constructor(readonly profileName: string) {
    super(`profile not authenticated: ${profileName}`);
    this.publicMessage =
      `A sessão do profile "${profileName}" expirou ou nunca foi iniciada. ` +
      `Autentique novamente — o que você digitou não foi perdido.`;
  }
}

export class SsoLoginFailedError extends AppError {
  readonly code = 'SSO_LOGIN_FAILED' as const;
  readonly httpStatus = 502;
  readonly publicMessage: string;

  constructor(
    readonly profileName: string,
    detail: string,
  ) {
    super(`sso login failed for ${profileName}: ${detail}`);
    this.publicMessage = detail;
  }
}

/**
 * A AWS recusou por permissão.
 *
 * Separado de falha genérica porque a ação do usuário é diferente: aqui não é
 * "tente de novo", é "falta permissão na policy".
 */
export class AwsAccessDeniedError extends AppError {
  readonly code = 'AWS_ACCESS_DENIED' as const;
  readonly httpStatus = 403;
  readonly publicMessage: string;

  constructor(
    readonly operation: string,
    readonly profileName: string,
  ) {
    super(`aws access denied on ${operation} for ${profileName}`);
    this.publicMessage =
      `A AWS recusou a operação ${operation} com o profile "${profileName}" por falta de ` +
      `permissão. Confira a policy da role — ver docs/iam-policy.json.`;
  }
}

/**
 * Falha da AWS que não é permissão nem parâmetro ausente.
 *
 * A mensagem é curada: nomeia a operação e o profile, nunca repassa o texto do
 * SDK, que pode embutir o valor da requisição.
 */
export class AwsRequestFailedError extends AppError {
  readonly code = 'AWS_REQUEST_FAILED' as const;
  readonly httpStatus = 502;
  readonly publicMessage: string;

  constructor(
    readonly operation: string,
    readonly awsErrorName: string,
  ) {
    super(`aws request failed: ${operation}: ${awsErrorName}`);
    this.publicMessage =
      `A chamada ${operation} à AWS falhou (${awsErrorName}). O detalhe técnico não é exibido ` +
      `porque a resposta do SDK pode conter valor de parâmetro; consulte o terminal do servidor.`;
  }
}

/**
 * Escrita ainda não habilitada no driver `aws`.
 *
 * O adapter nasce somente-leitura de propósito: nenhuma escrita em SSM real
 * antes de existir backup. Falhar explicitamente é melhor que gravar sem rede
 * de proteção.
 */
export class WriteNotEnabledError extends AppError {
  readonly code = 'WRITE_NOT_ENABLED' as const;
  readonly httpStatus = 501;
  readonly publicMessage: string;

  constructor(readonly parameterName: string) {
    super(`write not enabled on aws driver: ${parameterName}`);
    this.publicMessage =
      `A gravação no SSM real ainda não está habilitada. O adapter da AWS é somente-leitura até ` +
      `o backup local existir — nenhuma escrita em conta real sem rede de proteção.`;
  }
}

/**
 * O backup da versão anterior falhou, então a gravação foi abortada.
 *
 * Não é aviso: é bloqueio. O backup existe para que nenhuma escrita aconteça sem
 * cópia da versão anterior, e um backup que falha em silêncio é pior que backup
 * nenhum — cria a confiança sem a garantia. A consequência aceita é que disco
 * cheio ou permissão errada em `./.backups/` impedem salvar.
 */
export class BackupFailedError extends AppError {
  readonly code = 'BACKUP_FAILED' as const;
  readonly httpStatus = 500;
  readonly publicMessage: string;

  constructor(
    readonly parameterName: string,
    readonly reason: string,
  ) {
    super(`backup failed for ${parameterName}: ${reason}`);
    this.publicMessage =
      `A gravação foi abortada porque o backup da versão anterior de ${parameterName} falhou: ` +
      `${reason}. Nada foi alterado. Verifique espaço em disco e a permissão de ./.backups.`;
  }
}

export class StoreUnavailableError extends AppError {
  readonly code = 'STORE_UNAVAILABLE' as const;
  readonly httpStatus = 503;
  readonly publicMessage: string;

  constructor(detail: string, publicMessage: string) {
    super(`store unavailable: ${detail}`);
    this.publicMessage = publicMessage;
  }
}

export class StoreDriverNotImplementedError extends AppError {
  readonly code = 'STORE_DRIVER_NOT_IMPLEMENTED' as const;
  readonly httpStatus = 501;
  readonly publicMessage: string;

  constructor(readonly driver: string) {
    super(`store driver not implemented: ${driver}`);
    this.publicMessage =
      `O driver de store "${driver}" ainda não foi implementado. ` +
      `Use STORE_DRIVER=local até a Fase 3.`;
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}
