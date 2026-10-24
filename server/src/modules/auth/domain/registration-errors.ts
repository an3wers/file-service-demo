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

export class PasswordResetLinkInvalidError extends Error {
  constructor() {
    super("Ссылка недействительна. Запросите новое письмо восстановления");
  }
}

export class ActivationLinkInvalidError extends Error {
  constructor() {
    super("Ссылка недействительна. Запросите новое письмо активации");
  }
}
