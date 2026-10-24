export interface IssuedToken {
  token: string;
  expiresIn: number;
}
export interface AccessClaims {
  userId: string;
}
export interface Tokens {
  issueAccess(userId: string): Promise<IssuedToken>;
  verifyAccess(token: string): Promise<AccessClaims | null>;
}
