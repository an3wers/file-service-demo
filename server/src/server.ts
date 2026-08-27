import { app } from "./app.js";

const port = Number(process.env.PORT ?? 3000);

const server = app.listen(port, () => {
  console.log(`API listening on http://localhost:${port}`);
});

function shutdown(signal: string) {
  console.log(`${signal} received; shutting down gracefully`);

  server.close((error) => {
    if (error) {
      console.error("Failed to close HTTP server", error);
      process.exit(1);
    }

    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
