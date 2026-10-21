export class MailRateLimitedError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Слишком много запросов. Попробуйте позже");
  }
}

export class RegistrationUnavailableError extends Error {
  constructor() {
    super("Сервис временно недоступен. Попробуйте позже");
  }
}
