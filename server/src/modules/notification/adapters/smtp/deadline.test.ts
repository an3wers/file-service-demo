import { createServer } from "node:net";
import type { AddressInfo, Socket } from "node:net";
import { expect, it } from "vitest";
import { createSmtpTransport } from "./nodemailer-transport.js";

it("дедлайн закрывает реальное SMTP-соединение во время ожидания приветствия", async () => {
  let disconnected!: () => void;
  let connected!: () => void;
  const closed = new Promise<void>((resolve) => {
    disconnected = resolve;
  });
  const opened = new Promise<void>((resolve) => {
    connected = resolve;
  });
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    connected();
    socket.on("error", () => undefined);
    socket.on("close", disconnected);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const controller = new AbortController();
  const sending = createSmtpTransport({
    host: "127.0.0.1",
    port: (server.address() as AddressInfo).port,
    tlsMode: "starttls",
    user: "test",
    password: "test",
    connectionTimeoutMs: 3000,
    greetingTimeoutMs: 3000,
    socketTimeoutMs: 3000,
  }).send(
    {
      from: "sender@example.com",
      to: "user@example.com",
      subject: "Тема",
      text: "Текст",
    },
    { signal: controller.signal },
  );
  const settled = sending.catch(() => undefined);
  try {
    await opened;
    controller.abort();
    const result = await Promise.race([
      closed.then(() => "closed"),
      new Promise<string>((resolve) =>
        setTimeout(() => resolve("still open"), 150),
      ),
    ]);
    expect(result).toBe("closed");
  } finally {
    for (const socket of sockets) socket.destroy();
    await settled;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
