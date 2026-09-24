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

export const uploadFormSchema = uploadBodySchema.extend({
  file: z.file(),
});

export const presignUploadSchema = z.object({
  filename: z.string().min(1).max(512),
  directory: z.string().max(1024).optional(),
  contentType: z.string().min(1).max(255).optional(),
  size: z.coerce.number().int().nonnegative().optional(),
});

export const partUrlsSchema = z.object({
  // Shape only: a non-empty list of positive integers. How many may be asked
  // for at once is this deployment's policy, and which numbers exist needs the
  // stored plan, so both are checked in the multipart module.
  partNumbers: z.array(z.coerce.number().int().positive()).min(1),
});

export const listFilesQuerySchema = z.object({
  directory: z.string().max(1024).optional(),
  recursive: flag(false),
  search: z.string().max(255).optional(),
  status: z.enum(["pending", "ready", "failed", "any"]).meta({ id: "ListStatusFilter" }).default("ready"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z.enum(["created_at", "original_name", "size_bytes"]).meta({ id: "SortField" }).default("created_at"),
  order: z.enum(["asc", "desc"]).meta({ id: "SortOrder" }).default("desc"),
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
export type PartUrlsBody = z.infer<typeof partUrlsSchema>;
export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
export type FileCardQuery = z.infer<typeof fileCardQuerySchema>;
export type DownloadUrlQuery = z.infer<typeof downloadUrlQuerySchema>;
export type DirectoriesQuery = z.infer<typeof directoriesQuerySchema>;
export type IdParams = z.infer<typeof idParamsSchema>;
