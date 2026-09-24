import { describe, expect, it } from "vitest";
import { createScryptHasher } from "./scrypt-hasher.js";

const hasher = createScryptHasher({ N: 1024, r: 8, p: 1 });

describe("scrypt-хешер паролей", () => {
  it("пишет хеш в формате scrypt$N$r$p$salt$hash", async () => {
    const stored = await hasher.hash("correct horse");

    expect(stored).toMatch(/^scrypt\$1024\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  });

  it("солит каждый хеш заново", async () => {
    expect(await hasher.hash("correct horse")).not.toBe(await hasher.hash("correct horse"));
  });

  it("принимает верный пароль и отвергает неверный", async () => {
    const stored = await hasher.hash("correct horse");

    expect(await hasher.verify("correct horse", stored)).toBe(true);
    expect(await hasher.verify("correct horsE", stored)).toBe(false);
  });

  it("проверяет по параметрам из самого хеша, а не по своим", async () => {
    const stored = await createScryptHasher({ N: 2048, r: 8, p: 1 }).hash("correct horse");

    expect(await hasher.verify("correct horse", stored)).toBe(true);
  });

  it("считает испорченный хеш несовпадением, а не ошибкой", async () => {
    expect(await hasher.verify("correct horse", "not-a-hash")).toBe(false);
    expect(await hasher.verify("correct horse", "scrypt$x$8$1$AAAA$AAAA")).toBe(false);
  });
});
