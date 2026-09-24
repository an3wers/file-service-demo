import type { User } from "../user.js";

export interface NewUser {
  id: string;
  login: string;
  passwordHash: string;
}

export interface UserRowsForSessions {
  findByLogin(login: string): Promise<User | null>;

  findById(id: string): Promise<User | null>;
}

export interface UserRowsForEnvironment {
  insertIfAbsent(user: NewUser): Promise<void>;

  findByLogin(login: string): Promise<User | null>;

  replacePasswordHash(id: string, expectedHash: string, newHash: string): Promise<boolean>;
}

export type UserRows = UserRowsForSessions & UserRowsForEnvironment;
