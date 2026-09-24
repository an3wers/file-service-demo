import { z } from "zod";

export const fileStatusSchema = z.enum(["pending", "ready", "failed"]).meta({ id: "FileStatus" });

export const uploadSourceSchema = z
  .enum(["server", "presigned", "multipart"])
  .meta({ id: "UploadSource" });

export const fileDtoSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    directory: z.string(),
    extension: z.string(),
    contentType: z.string(),
    size: z.number().int().nullable().meta({
      description: "null, пока размер неизвестен, и у неудавшейся загрузки",
    }),
    etag: z.string().nullable(),
    status: fileStatusSchema,
    uploadSource: uploadSourceSchema,
    bucket: z.string(),
    key: z.string(),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
    downloadUrl: z.url().optional().meta({
      description: "Ключа нет, а не null, когда карточка запрошена без withUrl",
    }),
  })
  .meta({ id: "FileDto" });

export const paginationSchema = z
  .object({
    page: z.number().int(),
    limit: z.number().int(),
    total: z.number().int(),
    totalPages: z.number().int(),
  })
  .meta({ id: "Pagination" });

export const listFilesResponseSchema = z
  .object({
    items: z.array(fileDtoSchema),
    pagination: paginationSchema,
  })
  .meta({ id: "ListFilesResponse" });

export const directoryDtoSchema = z
  .object({
    name: z.string(),
    path: z.string(),
    fileCount: z.number().int(),
  })
  .meta({ id: "DirectoryDto" });

export const directoriesResponseSchema = z
  .object({
    parent: z.string(),
    items: z.array(directoryDtoSchema),
  })
  .meta({ id: "DirectoriesResponse" });

export const multipartPartDtoSchema = z
  .object({
    partNumber: z.number().int(),
    offset: z.number().int().meta({
      description: "Начало части в исходном файле: клиент режет file.slice(offset, offset + size)",
    }),
    size: z.number().int(),
    url: z.url(),
  })
  .meta({ id: "MultipartPartDto" });

export const presignSingleResponseSchema = z
  .object({
    strategy: z.literal("single"),
    id: z.uuid(),
    key: z.string(),
    directory: z.string(),
    uploadUrl: z.url(),
    expiresAt: z.iso.datetime(),
    requiredHeaders: z.record(z.string(), z.string()).meta({
      description: "Заголовки, вошедшие в подпись: PUT обязан отправить их дословно",
    }),
  })
  .meta({ id: "PresignSingleResponse" });

export const presignMultipartResponseSchema = z
  .object({
    strategy: z.literal("multipart"),
    id: z.uuid(),
    key: z.string(),
    directory: z.string(),
    uploadId: z.string(),
    size: z.number().int(),
    partSize: z.number().int(),
    partCount: z.number().int(),
    maxConcurrency: z.number().int().meta({
      description: "Сколько частей держать в полёте одновременно; число назначает сервер",
    }),
    expiresAt: z.iso.datetime(),
    parts: z.array(multipartPartDtoSchema).meta({
      description: "Первая пачка ссылок; остальные — через /multipart/part-urls",
    }),
  })
  .meta({ id: "PresignMultipartResponse" });

export const presignUploadResponseSchema = z
  .discriminatedUnion("strategy", [presignSingleResponseSchema, presignMultipartResponseSchema])
  .meta({ id: "PresignUploadResponse" });

export const partUrlsResponseSchema = z
  .object({
    expiresAt: z.iso.datetime(),
    parts: z.array(multipartPartDtoSchema),
  })
  .meta({ id: "PartUrlsResponse" });

export const multipartStatusResponseSchema = z
  .object({
    id: z.uuid(),
    uploadId: z.string(),
    size: z.number().int().nullable(),
    partSize: z.number().int().nullable(),
    partCount: z.number().int().nullable(),
    uploadedParts: z.array(z.number().int()),
    uploadedBytes: z.number().int(),
  })
  .meta({ id: "MultipartStatusResponse" });

export const downloadUrlResponseSchema = z
  .object({
    url: z.url(),
    expiresAt: z.iso.datetime(),
    name: z.string(),
  })
  .meta({ id: "DownloadUrlResponse" });

export type FileDto = z.output<typeof fileDtoSchema>;
export type ListFilesResponse = z.output<typeof listFilesResponseSchema>;
