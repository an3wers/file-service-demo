export interface PasswordHasher {
  hash(password: string): Promise<string>;

  verify(password: string, stored: string): Promise<boolean>;
}
