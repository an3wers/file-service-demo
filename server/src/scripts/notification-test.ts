import { z } from "zod";
import { createNotification } from "../composition.js";
import { logger } from "../logger.js";
import { NotificationError } from "../modules/notification/index.js";

const args = process.argv.slice(2);

if (
  args.length !== 2 ||
  args[0] !== "--to" ||
  !z.email().safeParse(args[1]).success
) {
  logger.error(
    { code: "INVALID_ARGUMENTS" },
    "Usage: npm run notification:test -w server -- --to recipient@example.com",
  );
  process.exitCode = 1;
} else {
  try {
    await createNotification().sendEmail({
      to: args[1]!,
      subject: "File service SMTP test",
      text: "This is a test email from the file service.",
    });
    logger.info(
      { code: "EMAIL_ACCEPTED" },
      "Test email accepted by SMTP; delivery and reading are not confirmed",
    );
    process.exitCode = 0;
  } catch (error) {
    const failure =
      error instanceof NotificationError
        ? error
        : new NotificationError("EMAIL_SEND_FAILED");
    logger.error(
      { err: new NotificationError(failure.code), code: failure.code },
      failure.message,
    );
    process.exitCode = 1;
  }
}
