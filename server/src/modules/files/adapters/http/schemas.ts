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
  operationId: z.uuid().optional(),
  directory: z.string().max(1024).optional(),
});

export const uploadFormSchema = uploadBodySchema.extend({
  file: z.file(),
});

export const presignUploadSchema = z.object({
  operationId: z.uuid().optional(),
  filename: z.string().min(1).max(512),
  directory: z.string().max(1024).optional(),
  contentType: z.string().min(1).max(255).optional(),
  size: z.coerce.number().int().nonnegative().optional(),
});

export const partUrlsSchema = z.object({
  // Только форма: сколько номеров можно запросить за раз, задаёт Политика
  // загрузки, а какие номера существуют — сохранённый План, поэтому обе
  // проверки выполняет модуль загрузок.
  partNumbers: z.array(z.coerce.number().int().positive()).min(1),
});

export const listFilesQuerySchema = z.object({
  directory: z.string().max(1024).optional(),
  recursive: flag(false),
  search: z.string().max(255).optional(),
  status: z
    .enum(["pending", "ready", "failed", "any"])
    .meta({ id: "ListStatusFilter" })
    .default("ready"),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(200).default(50),
  sort: z
    .enum(["created_at", "original_name", "size_bytes"])
    .meta({ id: "SortField" })
    .default("created_at"),
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

export const directoryPathQuerySchema = z.object({
  path: z.string().max(1024),
});

export type UploadBody = z.infer<typeof uploadBodySchema>;
export type PresignUploadBody = z.infer<typeof presignUploadSchema>;
export type PartUrlsBody = z.infer<typeof partUrlsSchema>;
export type ListFilesQuery = z.infer<typeof listFilesQuerySchema>;
export type FileCardQuery = z.infer<typeof fileCardQuerySchema>;
export type DownloadUrlQuery = z.infer<typeof downloadUrlQuerySchema>;
export type DirectoriesQuery = z.infer<typeof directoriesQuerySchema>;
export type DirectoryPathQuery = z.infer<typeof directoryPathQuerySchema>;
export type IdParams = z.infer<typeof idParamsSchema>;

export const createDirectorySchema = z
  .object({
    parent: z.string().max(1024).optional(),
    name: z.string().max(512),
  })
  .meta({ id: "CreateDirectoryBody" });

export const updateDirectorySchema = z
  .object({
    name: z.string().max(512).optional(),
    parent: z.string().max(1024).optional(),
  })
  .refine((body) => body.name !== undefined || body.parent !== undefined, {
    message: "Укажите новое имя или родительский каталог",
  })
  .meta({ id: "UpdateDirectoryBody" });

export const updateFileSchema = z
  .object({
    name: z.string().max(512).optional(),
    directory: z.string().max(1024).optional(),
  })
  .refine((body) => body.name !== undefined || body.directory !== undefined, {
    message: "Укажите новое имя или каталог",
  })
  .meta({ id: "UpdateFileBody" });

export const resolveUploadSchema = z
  .object({
    stoppedUploadId: z.string().min(1).max(1024).optional(),
  })
  .prefault({});
