export class AuthDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class InvalidCredentialsError extends AuthDomainError {
  constructor() {
    super("Invalid login or password");
  }
}

export class SessionExpiredError extends AuthDomainError {
  constructor() {
    super("The session has expired; sign in again");
  }
}
