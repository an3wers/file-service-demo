import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { Router } from "express";
import { afterEach, describe, expect, it } from "vitest";
import { API_DOCS_PATH, API_SPEC_PATH, createApp } from "./app.js";

const document = { openapi: "3.1.0", info: { title: "test", version: "0.0.0" }, paths: {} };

let server: Server | undefined;

async function start(apiDocs?: object): Promise<string> {
  const app = createApp({
    healthRouter: Router(),
    authRouter: Router(),
    requireAuth: (_req, _res, next) => next(),
    filesRouter: Router(),
    directoriesRouter: Router(),
    corsOrigin: [],
    apiDocs,
  });

  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });

  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

describe("документация API", () => {
  it("отдаёт спецификацию и Swagger UI без токена доступа, когда включена", async () => {
    const base = await start(document);

    const spec = await fetch(`${base}${API_SPEC_PATH}`);
    const ui = await fetch(`${base}${API_DOCS_PATH}/`);

    expect(spec.status).toBe(200);
    expect(await spec.json()).toEqual(document);
    expect(ui.status).toBe(200);
    expect(await ui.text()).toContain("swagger-ui");
  });

  it("не отдаёт ни спецификацию, ни Swagger UI, когда выключена", async () => {
    const base = await start();
    const spec = await fetch(`${base}${API_SPEC_PATH}`);
    const ui = await fetch(`${base}${API_DOCS_PATH}/`);

    expect(spec.status).toBe(404);
    expect(ui.status).toBe(404);
  });
});
