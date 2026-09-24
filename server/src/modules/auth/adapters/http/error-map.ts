import { AppError, ERROR_CODES } from "../../../../errors.js";
import { AuthDomainError, InvalidCredentialsError, SessionExpiredError } from "../../domain/errors.js";

function codeOf(error: AuthDomainError) {
  if (error instanceof InvalidCredentialsError) {
    return ERROR_CODES.INVALID_CREDENTIALS;
  }

  return error instanceof SessionExpiredError ? ERROR_CODES.SESSION_EXPIRED : undefined;
}

export function mapAuthError(error: unknown): AppError | undefined {
  const code = error instanceof AuthDomainError ? codeOf(error) : undefined;

  return code ? new AppError(401, code, (error as Error).message, undefined, { cause: error }) : undefined;
}
