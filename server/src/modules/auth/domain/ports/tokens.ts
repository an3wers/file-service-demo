export interface IssuedToken {
  token: string;
  expiresIn: number;
}

export interface AccessClaims {
  userId: string;
}

export interface RefreshClaims {
  userId: string;
  version: number;
}

export interface Tokens {
  issueAccess(userId: string): Promise<IssuedToken>;

  issueRefresh(userId: string, version: number): Promise<IssuedToken>;

  verifyAccess(token: string): Promise<AccessClaims | null>;

  verifyRefresh(token: string): Promise<RefreshClaims | null>;
}
