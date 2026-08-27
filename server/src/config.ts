import { z } from "zod";

const booleanish = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  API_KEY: z.string().min(16, "API_KEY must be at least 16 characters"),
  CORS_ORIGIN: z.string().default("http://localhost:5173"),

  S3_ENDPOINT: z.url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET_NAME: z.string().min(1),
  S3_TENANT_ID: z.string().min(1),
  KEY_ID: z.string().min(1),
  KEY_SECRET: z.string().min(1),

  DATABASE_HOST: z.string().min(1),
  DATABASE_PORT: z.coerce.number().int().positive().default(5432),
  DATABASE_NAME: z.string().min(1),
  DATABASE_USER: z.string().min(1),
  DATABASE_PASSWORD: z.string(),
  DATABASE_POOL_SIZE: z.coerce.number().int().positive().default(10),
  DATABASE_SSL: booleanish.default(false),

  MAX_UPLOAD_SIZE_MB: z.coerce.number().int().positive().default(50),
  PRESIGN_UPLOAD_TTL_SECONDS: z.coerce.number().int().positive().max(604800).default(900),
  PRESIGN_DOWNLOAD_TTL_SECONDS: z.coerce.number().int().positive().max(604800).default(300),
  PENDING_TTL_HOURS: z.coerce.number().int().positive().default(24),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n");

  console.error(`Invalid environment configuration:\n${issues}`);
  process.exit(1);
}

const env = parsed.data;

export const config = {
  env: env.NODE_ENV,
  isProduction: env.NODE_ENV === "production",
  port: env.PORT,
  logLevel: env.LOG_LEVEL,
  apiKey: env.API_KEY,
  corsOrigin: env.CORS_ORIGIN.split(",").map((origin) => origin.trim()).filter(Boolean),

  s3: {
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    bucket: env.S3_BUCKET_NAME,
    // Cloud.ru expects the access key id as `<tenant_id>:<key_id>`.
    accessKeyId: `${env.S3_TENANT_ID}:${env.KEY_ID}`,
    secretAccessKey: env.KEY_SECRET,
  },

  database: {
    host: env.DATABASE_HOST,
    port: env.DATABASE_PORT,
    database: env.DATABASE_NAME,
    user: env.DATABASE_USER,
    password: env.DATABASE_PASSWORD,
    poolSize: env.DATABASE_POOL_SIZE,
    ssl: env.DATABASE_SSL,
  },

  uploads: {
    maxSizeBytes: env.MAX_UPLOAD_SIZE_MB * 1024 * 1024,
    maxSizeMb: env.MAX_UPLOAD_SIZE_MB,
    presignUploadTtlSeconds: env.PRESIGN_UPLOAD_TTL_SECONDS,
    presignDownloadTtlSeconds: env.PRESIGN_DOWNLOAD_TTL_SECONDS,
    pendingTtlHours: env.PENDING_TTL_HOURS,
  },
} as const;
