export interface User {
  id: string;
  login: string;
  passwordHash: string;
  tokenVersion: number;
  state: "active" | "inactive";
}
