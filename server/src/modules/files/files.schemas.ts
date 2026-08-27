import { z } from "zod";

const flag = (defaultValue: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .default(defaultValue ? "true" : "false")
    .transform((value) => value === "true" || value === "1");

export const idParamsSchema = z.object({
  id: z.uuid("File id must be a UUID"),
});

export const uploadBodySchema = z.object({
  directory: z.string().max(1024).optional(),
});

export const presignUploadSchema = z.object({
  filename: z.string().min(1).max(512),
  directory: z.string().max(1024).optional(),
  contentType: z.string().min(1).max(255).optional(),
  size: z.coerce.number().int().nonnegative().optional(),
});

export const listFilesQuerySchema = z.object({
  directory: z.string().max(1024).optional(),
  recursive: flag(false),
  search: z.string().max(255).optional(),
  status: z.enum(["pending", "ready", "failed", "any"]).default("ready"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z.enum(["created_at", "original_name", "size_bytes"]).default("created_at"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

export const fileCardQuerySchema = z.object({
  withUrl: flag(false),
});

export const downloadUrlQuerySchema = z.object({
  disposition: z.enum(["attachment", "inline"]).default("attachment"),
  expiresIn: z.coerce.number().int().positive().max(604800).optional(),
});

export const directoriesQuerySchema = z.object({
  parent: z.string().max(1024).optional(),
});

export type UploadBody = z.infer<typeof uploadBodySchema>;
export type PresignUploadBody = z.infer<typeof presignUploadSchema>;
export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
export type FileCardQuery = z.infer<typeof fileCardQuerySchema>;
export type DownloadUrlQuery = z.infer<typeof downloadUrlQuerySchema>;
export type DirectoriesQuery = z.infer<typeof directoriesQuerySchema>;
export type IdParams = z.infer<typeof idParamsSchema>;
