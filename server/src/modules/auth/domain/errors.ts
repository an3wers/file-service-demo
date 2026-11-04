export class AuthDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCredentialsError extends AuthDomainError {
  constructor() {
    super("Неверный email или пароль");
  }
}

export class SessionExpiredError extends AuthDomainError {
  constructor() {
    super("The session has expired; sign in again");
  }
}

export class EmailNotVerifiedError extends AuthDomainError {
  constructor() {
    super("Подтвердите email, чтобы войти");
  }
}
export class LoginAttemptInvalidError extends AuthDomainError {
  constructor() {
    super("Попытка входа завершена. Войдите заново");
  }
}
export class LoginCodeExpiredError extends AuthDomainError {
  constructor() {
    super("Срок кода истёк. Начните новый вход");
  }
}
export class LoginCodeInvalidError extends AuthDomainError {
  constructor(public readonly remainingAttempts: number) {
    super("Неверный код входа");
  }
}

export class LoginCodeFormatError extends AuthDomainError {
  constructor() {
    super("Введите шесть цифр");
  }
}

export class RegistrationAttemptInvalidError extends LoginAttemptInvalidError {
  constructor() {
    super();
    this.message =
      "Попытка регистрации завершена. Войдите или восстановите доступ";
  }
}
export class RegistrationCodeExpiredError extends LoginCodeExpiredError {
  constructor() {
    super();
    this.message = "Срок кода истёк. Войдите или восстановите доступ";
  }
}
export class RegistrationCodeInvalidError extends LoginCodeInvalidError {
  constructor(remainingAttempts: number) {
    super(remainingAttempts);
    this.message = "Неверный код подтверждения";
  }
}
