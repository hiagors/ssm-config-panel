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
  | 'PARAMETER_NOT_FOUND'
  | 'PARAMETER_NAME_COLLISION'
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
