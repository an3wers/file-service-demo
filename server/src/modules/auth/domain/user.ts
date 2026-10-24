export interface User {
  id: string;
  name: string;
  email: string;
  passwordHash: string;
  tokenVersion: number;
  state: "active" | "inactive";
}
