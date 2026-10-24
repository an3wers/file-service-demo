import { AppError, ERROR_CODES } from "../../../../errors.js";
import {
  InvalidCredentialsError,
  SessionExpiredError,
  EmailNotVerifiedError,
  LoginAttemptInvalidError,
  LoginCodeExpiredError,
  LoginCodeInvalidError,
  LoginCodeFormatError,
} from "../../domain/errors.js";

export function mapAuthError(error: unknown): AppError | undefined {
  if (error instanceof InvalidCredentialsError)
    return new AppError(401, ERROR_CODES.INVALID_CREDENTIALS, error.message);
  if (error instanceof SessionExpiredError)
    return new AppError(401, ERROR_CODES.SESSION_EXPIRED, error.message);
  if (error instanceof EmailNotVerifiedError)
    return new AppError(403, ERROR_CODES.EMAIL_NOT_VERIFIED, error.message);
  if (error instanceof LoginAttemptInvalidError)
    return new AppError(410, ERROR_CODES.LOGIN_ATTEMPT_INVALID, error.message);
  if (error instanceof LoginCodeExpiredError)
    return new AppError(400, ERROR_CODES.LOGIN_CODE_EXPIRED, error.message);
  if (error instanceof LoginCodeInvalidError)
    return new AppError(400, ERROR_CODES.LOGIN_CODE_INVALID, error.message, {
      remainingAttempts: error.remainingAttempts,
    });
  if (error instanceof LoginCodeFormatError)
    return new AppError(
      422,
      ERROR_CODES.VALIDATION_ERROR,
      "Проверьте поля формы",
      { formErrors: [], fieldErrors: { code: [error.message] } },
    );
  return undefined;
}
