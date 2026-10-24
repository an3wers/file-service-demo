import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Router } from "express";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { pool } from "../../../../db/pool.js";
import { migrate } from "../../../../db/migrate.js";
import { config } from "../../../../config.js";
import { buildApp, uploadPolicy } from "../../../../composition.js";
import { createAuthHttp } from "../../../auth/index.js";
import { createFilesPersistence } from "../../persistence.js";
import { createFilesMaintenance } from "../../index.js";
import { createMemoryObjectStore } from "../../../../storage/memory-object-store.js";
import { createTestClock } from "../../../../testing/clock.js";
import type { MemoryObjectStore } from "../../../../storage/memory-object-store.js";

const schema = `ownership_test_${randomUUID().replaceAll("-", "")}`;
let created = false;
const servers: Server[] = [];
const PASSWORD = "correct horse battery";
const ORIGIN = config.registration.allowedOrigins[0]!;

beforeAll(async () => {
  await pool.query(`create schema ${schema}`);
  created = true;
  await pool.query(`set search_path to ${schema}`);
  pool.options.options = `-c search_path=${schema}`;
  await migrate();
});
beforeEach(async () => {
  await pool.query(
    "truncate login_attempts, auth_sessions, auth_secrets, auth_mail_events, users, upload_terminations cascade",
  );
});
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
afterAll(async () => {
  if (created) await pool.query(`drop schema ${schema} cascade`);
  await pool.end();
});

async function start(objectStore: MemoryObjectStore) {
  const sendEmail = vi.fn().mockResolvedValue({ messageId: "accepted" });
  const app = buildApp({
    files: {
      ...createFilesPersistence("test-bucket"),
      objectStore,
      policy: uploadPolicy(),
    },
    healthRouter: Router(),
    auth: createAuthHttp(config.auth, {
      ...config.registration,
      deadlineMs: 300,
      notification: { sendEmail },
    }),
    corsOrigin: [],
    maxUploadSizeBytes: 1024,
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (path: string, body: unknown) =>
    fetch(`${base}/api/auth/${path}`, {
      method: "POST",
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const lastMail = () => sendEmail.mock.calls.at(-1)![0].text as string;

  async function signUp(email: string) {
    expect(
      (await post("register", { name: "Имя", email, password: PASSWORD }))
        .status,
    ).toBe(202);
    const token = new URL(lastMail().match(/https:\/\/\S+/)![0]).hash.slice(7);
    expect((await post("activation/confirm", { token })).status).toBe(200);
    return await signIn(email);
  }

  async function signIn(email: string) {
    const attempt = await post("login", { email, password: PASSWORD });
    expect(attempt.status).toBe(200);
    const verified = await post("login/verify", {
      attemptToken: (await attempt.json()).attemptToken,
      code: lastMail().match(/[0-9]{6}/)![0],
    });
    expect(verified.status).toBe(200);
    return client((await verified.json()).accessToken);
  }

  function client(accessToken: string) {
    const call = (method: string, path: string, body?: unknown) =>
      fetch(`${base}/api${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${accessToken}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    return {
      accessToken,
      call,
      async json(method: string, path: string, body?: unknown) {
        const response = await call(method, path, body);
        return { status: response.status, body: await response.json() };
      },
      async send(
        name: string,
        content: string,
        directory = "",
        operationId = randomUUID(),
      ) {
        const form = new FormData();
        form.append("directory", directory);
        form.append("operationId", operationId);
        form.append("file", new Blob([content], { type: "text/plain" }), name);
        const response = await fetch(`${base}/api/files`, {
          method: "POST",
          headers: { Authorization: `Bearer ${accessToken}` },
          body: form,
        });
        const body = await response.json();
        if (body.error) delete body.error.requestId;
        return { status: response.status, body };
      },
      async upload(name: string, content: string, directory = "") {
        const response = await this.send(name, content, directory);
        expect(response.status).toBe(201);
        return response.body;
      },
    };
  }

  return { base, signUp, signIn, client };
}

type Client = Awaited<ReturnType<Awaited<ReturnType<typeof start>>["signUp"]>>;

async function publicShape(
  user: Client,
  method: string,
  path: string,
  value: string,
  body?: unknown,
) {
  const response = await user.call(
    method,
    path.replace(":value", value),
    body === undefined
      ? undefined
      : JSON.parse(JSON.stringify(body).replaceAll(":value", value)),
  );
  const text = (await response.text()).replaceAll(value, ":value");
  const parsed = text ? JSON.parse(text) : null;
  if (parsed?.error) delete parsed.error.requestId;
  return { status: response.status, body: parsed };
}

async function expectSameAsMissing(
  user: Client,
  method: string,
  path: string,
  foreign: string,
  missing: string,
  body?: unknown,
) {
  const answer = await publicShape(user, method, path, foreign, body);
  expect(answer.status).not.toBe(200);
  expect(answer).toEqual(await publicShape(user, method, path, missing, body));
}

describe(
  "личное пространство через HTTP на PostgreSQL",
  { timeout: 30_000 },
  () => {
    it("новые пользователи видят пустой личный корень, одинаковые пути и имена не конфликтуют", async () => {
      const objectStore = createMemoryObjectStore();
      const h = await start(objectStore);
      const alice = await h.signUp("alice@example.com");
      const bob = await h.signUp("bob@example.com");

      for (const user of [alice, bob]) {
        expect(await user.json("GET", "/directories")).toEqual({
          status: 200,
          body: { parent: "", items: [] },
        });
        expect((await user.json("GET", "/files")).body).toMatchObject({
          items: [],
          pagination: { total: 0 },
        });
      }

      const created = await Promise.all(
        [alice, bob].map((user) =>
          user.json("POST", "/directories", { name: "docs" }),
        ),
      );
      expect(created.map((response) => response.status)).toEqual([201, 201]);
      const [aliceFile, bobFile] = await Promise.all([
        alice.upload("same.txt", "alice", "docs"),
        bob.upload("same.txt", "bob!!", "docs"),
      ]);
      expect(aliceFile.key).not.toBe(bobFile.key);
      expect(objectStore.objectAt(aliceFile.key)!.body.toString()).toBe(
        "alice",
      );
      expect(objectStore.objectAt(bobFile.key)!.body.toString()).toBe("bob!!");

      for (const [user, own] of [
        [alice, aliceFile],
        [bob, bobFile],
      ] as const) {
        expect(
          (await user.json("GET", "/files?directory=docs")).body.items,
        ).toEqual([own]);
        expect(
          (await user.json("GET", "/files?search=same&recursive=true")).body,
        ).toMatchObject({ items: [own], pagination: { total: 1 } });
        expect((await user.json("GET", "/directories")).body.items).toEqual([
          { name: "docs", path: "docs", fileCount: 1 },
        ]);
      }

      await bob.json("POST", "/directories", { name: "private" });
      const missing = "nothing-here";
      for (const [method, path, body] of [
        ["GET", "/directories?parent=:value"],
        ["GET", "/files?directory=:value"],
        ["POST", "/directories", { parent: ":value", name: "x" }],
        [
          "POST",
          "/files/presign-upload",
          { filename: "a.txt", directory: ":value", size: 5 },
        ],
      ] as const)
        await expectSameAsMissing(
          alice,
          method,
          path,
          "private",
          missing,
          body,
        );
      const proxied = await alice.send("a.txt", "x", "private");
      expect(proxied.status).toBe(404);
      expect(proxied).toEqual(
        JSON.parse(
          JSON.stringify(await alice.send("a.txt", "x", missing)).replaceAll(
            missing,
            "private",
          ),
        ),
      );
      expect((await alice.json("GET", "/directories")).body.items).toHaveLength(
        1,
      );

      const restarted = await start(objectStore);
      const again = restarted.client(alice.accessToken);
      expect(
        (await again.json("GET", "/files?recursive=true")).body.items,
      ).toEqual([aliceFile]);
    });

    it("подстановка чужих идентификаторов неотличима от отсутствия и не меняет чужие данные", async () => {
      const objectStore = createMemoryObjectStore();
      const h = await start(objectStore);
      const alice = await h.signUp("alice@example.com");
      const bob = await h.signUp("bob@example.com");
      const ready = await alice.upload("ready.txt", "hello");
      const operationId = randomUUID();
      const pending = await alice.json("POST", "/files/presign-upload", {
        operationId,
        filename: "pending.txt",
        size: 5,
      });
      expect(pending.status).toBe(201);
      const multipartOperation = randomUUID();
      const multipart = await alice.json("POST", "/files/presign-upload", {
        operationId: multipartOperation,
        filename: "big.bin",
        size: uploadPolicy().multipartThresholdBytes + 1,
      });
      expect(multipart.body.strategy).toBe("multipart");

      const missing = randomUUID();
      for (const id of [ready.id, pending.body.id, multipart.body.id])
        for (const [method, path, body] of [
          ["GET", "/files/:value"],
          ["GET", "/files/:value?withUrl=true"],
          ["GET", "/files/:value/download-url"],
          ["GET", "/files/:value/multipart"],
          ["POST", "/files/:value/multipart/part-urls", { partNumbers: [1] }],
          ["POST", "/files/:value/complete"],
          ["DELETE", "/files/:value"],
        ] as const)
          await expectSameAsMissing(bob, method, path, id, missing, body);
      for (const action of ["", "/resolve", "/fail", "/cancel"])
        expect(
          await publicShape(
            bob,
            action === "" ? "GET" : "POST",
            `/files/upload-operations/:value${action}`,
            multipartOperation,
          ),
        ).toEqual(
          await publicShape(
            bob,
            action === "" ? "GET" : "POST",
            `/files/upload-operations/:value${action}`,
            randomUUID(),
          ),
        );
      const reused = await bob.json("POST", "/files/presign-upload", {
        operationId,
        filename: "other.txt",
        size: 3,
      });
      expect(reused.status).toBe(201);
      const sharedId = randomUUID();
      const aliceProxied = await alice.send("mine.txt", "alice", "", sharedId);
      const proxied = await bob.send("other.txt", "bob", "", sharedId);
      expect(proxied.status).toBe(201);
      expect(proxied.body.id).not.toBe(aliceProxied.body.id);
      expect(reused.body.id).not.toBe(pending.body.id);

      expect(await alice.json("GET", `/files/${ready.id}`)).toEqual({
        status: 200,
        body: ready,
      });
      expect(
        await alice.json("GET", `/files/upload-operations/${operationId}`),
      ).toEqual({ status: 200, body: { status: "pending" } });
      expect(
        await alice.json(
          "GET",
          `/files/upload-operations/${multipartOperation}`,
        ),
      ).toEqual({ status: 200, body: { status: "pending" } });
      expect(
        (await alice.json("GET", `/files/${multipart.body.id}/multipart`))
          .status,
      ).toBe(200);
      objectStore.uploadObject(pending.body.key, Buffer.from("hello"));
      expect(
        (await alice.json("POST", `/files/${pending.body.id}/complete`)).body,
      ).toMatchObject({ status: "ready" });
      expect(
        (await alice.json("GET", "/files?recursive=true&status=any")).body
          .pagination.total,
      ).toBe(4);
      expect(
        (await bob.json("GET", "/files?recursive=true&status=any")).body.items
          .map((file: { id: string }) => file.id)
          .sort(),
      ).toEqual([reused.body.id, proxied.body.id].sort());
    });

    it("одновременные операции двух владельцев с одним идентификатором независимы", async () => {
      const h = await start(createMemoryObjectStore());
      const users = [
        await h.signUp("alice@example.com"),
        await h.signUp("bob@example.com"),
      ];
      const operationId = randomUUID();
      const started = await Promise.all(
        users.flatMap((user) =>
          [1, 2].map(() =>
            user.json("POST", "/files/presign-upload", {
              operationId,
              filename: "same.txt",
              size: 5,
            }),
          ),
        ),
      );
      const ids = await Promise.all(
        users.map(async (user) => {
          const listed = await user.json(
            "GET",
            "/files?recursive=true&status=any",
          );
          expect(listed.body.items).toHaveLength(1);
          return listed.body.items[0].id;
        }),
      );
      expect(new Set(ids).size).toBe(2);
      for (const response of started)
        if (response.status === 201) expect(ids).toContain(response.body.id);
        else expect(response.status).toBe(409);
    });

    it("подписанную ссылку на скачивание выдают только владельцу со сроком политики", async () => {
      const objectStore = createMemoryObjectStore();
      const h = await start(objectStore);
      const alice = await h.signUp("alice@example.com");
      const bob = await h.signUp("bob@example.com");
      const file = await alice.upload("ready.txt", "hello");

      const link = await alice.json("GET", `/files/${file.id}/download-url`);
      expect(link.status).toBe(200);
      const url = new URL(link.body.url);
      expect(url.searchParams.get("expiresIn")).toBe(
        String(uploadPolicy().presignDownloadTtlSeconds),
      );
      expect(
        objectStore.objectAt(decodeURIComponent(url.pathname.slice(1)))!.body,
      ).toEqual(Buffer.from("hello"));
      expect(
        (await bob.json("GET", `/files/${file.id}/download-url`)).status,
      ).toBe(404);
    });

    it("переименовать и переместить файл может только владелец и только в свой каталог", async () => {
      const objectStore = createMemoryObjectStore();
      const h = await start(objectStore);
      const alice = await h.signUp("alice@example.com");
      const bob = await h.signUp("bob@example.com");
      await alice.json("POST", "/directories", { name: "docs" });
      await bob.json("POST", "/directories", { name: "private" });
      const aliceFile = await alice.upload("report.txt", "hello");
      const bobFile = await bob.upload("own.txt", "bob");

      await expectSameAsMissing(
        bob,
        "PATCH",
        "/files/:value",
        aliceFile.id,
        randomUUID(),
        { name: "stolen.txt" },
      );
      await expectSameAsMissing(
        alice,
        "PATCH",
        `/files/${aliceFile.id}`,
        "private",
        "nothing-here",
        { directory: ":value" },
      );

      const moved = await alice.json("PATCH", `/files/${aliceFile.id}`, {
        name: "Итоги.txt",
        directory: "docs",
      });
      expect(moved).toMatchObject({
        status: 200,
        body: {
          id: aliceFile.id,
          key: aliceFile.key,
          name: "Итоги.txt",
          directory: "docs",
        },
      });
      const link = await alice.json(
        "GET",
        `/files/${aliceFile.id}/download-url`,
      );
      expect(link.body.name).toBe("Итоги.txt");
      expect(
        objectStore.objectAt(
          decodeURIComponent(new URL(link.body.url).pathname.slice(1)),
        )!.body,
      ).toEqual(Buffer.from("hello"));
      expect((await alice.json("GET", "/directories")).body.items).toEqual([
        { name: "docs", path: "docs", fileCount: 1 },
      ]);
      expect(
        (await alice.json("PATCH", `/files/${aliceFile.id}`, { directory: "" }))
          .body,
      ).toMatchObject({ directory: "", key: aliceFile.key });
      expect(await bob.json("GET", `/files/${bobFile.id}`)).toEqual({
        status: 200,
        body: bobFile,
      });
    });

    it("одновременные изменение и удаление файла не оставляют частично изменённых данных", async () => {
      const objectStore = createMemoryObjectStore();
      const h = await start(objectStore);
      const alice = await h.signUp("alice@example.com");
      await alice.json("POST", "/directories", { name: "docs" });
      for (let round = 0; round < 5; round += 1) {
        const file = await alice.upload("report.txt", "hello");
        const [patched, removed, renamed] = await Promise.all([
          alice.json("PATCH", `/files/${file.id}`, {
            name: "a.txt",
            directory: "docs",
          }),
          alice.call("DELETE", `/files/${file.id}`),
          alice.json("PATCH", `/files/${file.id}`, { name: "b.txt" }),
        ]);
        expect(removed.status).toBe(204);
        for (const response of [patched, renamed])
          expect([200, 404, 409]).toContain(response.status);
        expect((await alice.json("GET", `/files/${file.id}`)).status).toBe(404);
        expect(objectStore.objectAt(file.key)).toBeNull();
      }
      const survivor = await alice.upload("report.txt", "hello");
      const results = await Promise.all([
        alice.json("PATCH", `/files/${survivor.id}`, {
          name: "a.txt",
          directory: "docs",
        }),
        alice.json("PATCH", `/files/${survivor.id}`, { name: "b.txt" }),
      ]);
      expect(results.map((result) => result.status)).toEqual([200, 200]);
      const final = (await alice.json("GET", `/files/${survivor.id}`)).body;
      expect([
        { name: "b.txt", directory: "docs" },
        { name: "a.txt", directory: "docs" },
      ]).toContainEqual({ name: final.name, directory: final.directory });
      expect(final.key).toBe(survivor.key);
    });

    it("уборка без сессии обрабатывает загрузки всех владельцев с одинаковыми путями независимо", async () => {
      const objectStore = createMemoryObjectStore({
        clock: createTestClock(new Date("2020-01-01T00:00:00Z")),
      });
      const h = await start(objectStore);
      const alice = await h.signUp("alice@example.com");
      const bob = await h.signUp("bob@example.com");
      const reserve = async (user: Client) => {
        await user.json("POST", "/directories", { name: "docs" });
        return (
          await user.json("POST", "/files/presign-upload", {
            filename: "same.txt",
            directory: "docs",
            size: 5,
          })
        ).body;
      };
      const aliceUpload = await reserve(alice);
      const bobUpload = await reserve(bob);
      const live = (
        await bob.json("POST", "/files/presign-upload", {
          filename: "big.bin",
          size: uploadPolicy().multipartThresholdBytes + 1,
        })
      ).body;
      await objectStore.beginMultipart("docs/orphan.bin", {
        contentType: "application/octet-stream",
      });
      objectStore.uploadObject(aliceUpload.key, Buffer.from("hello"));
      await pool.query(
        "update files set attempt_started_at = now() - interval '2 days' where upload_id is null",
      );

      await createFilesMaintenance({
        ...createFilesPersistence("test-bucket"),
        objectStore,
        policy: uploadPolicy(),
      })();

      expect(
        (await alice.json("GET", `/files/${aliceUpload.id}`)).body,
      ).toMatchObject({ status: "ready", size: 5 });
      expect(
        (await bob.json("GET", `/files/${bobUpload.id}`)).body,
      ).toMatchObject({ status: "failed" });
      expect(objectStore.objectAt(aliceUpload.key)).not.toBeNull();
      expect(
        objectStore.openUploads().map((upload) => upload.uploadId),
      ).toEqual([live.uploadId]);
    });
  },
);

describe("ограничения владения в PostgreSQL", () => {
  it("схема не связывает объекты разных владельцев и не принимает строки без владельца", async () => {
    const owner = async () => {
      const id = randomUUID();
      await pool.query(
        "insert into users (id, login, password_hash) values ($1, $2, 'x')",
        [id, id],
      );
      return id;
    };
    const alice = await owner();
    const bob = await owner();
    expect(
      (
        await pool.query(
          "select owner_id from directories where path = '' and owner_id is not null order by owner_id",
        )
      ).rows,
    ).toEqual([alice, bob].sort().map((id) => ({ owner_id: id })));
    await pool.query(
      "insert into directories (owner_id, path, parent, name) values ($1, 'docs', '', 'docs')",
      [alice],
    );
    const file = (ownerId: string | null, directory: string) =>
      pool.query(
        `insert into files (id, bucket, object_key, directory, original_name, status, upload_source, owner_id)
         values ($1, 'test', $4, $2, 'a.txt', 'pending', 'presigned', $3)`,
        [randomUUID(), directory, ownerId, randomUUID()],
      );

    await expect(file(bob, "docs")).rejects.toMatchObject({ code: "23503" });
    await expect(file(null, "docs")).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "insert into directories (owner_id, path, parent, name) values ($1, 'docs/x', 'docs', 'x')",
        [bob],
      ),
    ).rejects.toMatchObject({ code: "23503" });
    await expect(
      pool.query(
        "insert into directories (owner_id, path, parent, name) values (null, 'free', '', 'free')",
      ),
    ).rejects.toMatchObject({ code: "23514" });
    await file(alice, "docs");
    await pool.query(
      "insert into directories (owner_id, path, parent, name) values ($1, 'docs', '', 'docs')",
      [bob],
    );
    await file(bob, "docs");
    const aliceFile = (
      await pool.query("select id from files where owner_id = $1", [alice])
    ).rows[0].id;
    const operation = (ownerId: string | null) =>
      pool.query(
        `insert into upload_operations (id, file_id, object_key, directory, original_name, extension, content_type, owner_id)
         values ($1, $2, 'k', 'docs', 'a.txt', 'txt', 'text/plain', $3)`,
        [randomUUID(), aliceFile, ownerId],
      );
    await expect(operation(bob)).rejects.toMatchObject({ code: "23514" });
    await expect(operation(null)).rejects.toMatchObject({ code: "23514" });
    await operation(alice);
    await expect(
      pool.query("update files set owner_id = $2 where id = $1", [
        aliceFile,
        bob,
      ]),
    ).rejects.toMatchObject({ code: "23514" });
  });
});
