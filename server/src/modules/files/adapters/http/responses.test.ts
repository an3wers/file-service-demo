import { describe, expectTypeOf, it } from "vitest";
import type { z } from "zod";
import type { Serialized } from "../../../../http-contract.js";
import type { GetDownloadUrlResult } from "../../application/catalog.js";
import type { MultipartStatus, PartUrlsResult } from "../../application/multipart.js";
import type { PresignUploadResult } from "../../application/uploads.js";
import type { FileStatus, UploadSource } from "../../domain/stored-file.js";
import type { DirectoryDto } from "../../domain/ports/file-rows.js";
import type {
  directoryDtoSchema,
  downloadUrlResponseSchema,
  fileStatusSchema,
  multipartStatusResponseSchema,
  partUrlsResponseSchema,
  presignUploadResponseSchema,
  uploadSourceSchema,
} from "./responses.js";

describe("схемы ответов совпадают с тем, что отдают сценарии", () => {
  it("presign-upload", () => {
    expectTypeOf<Serialized<PresignUploadResult>>().toEqualTypeOf<
      z.output<typeof presignUploadResponseSchema>
    >();
  });

  it("part-urls", () => {
    expectTypeOf<Serialized<PartUrlsResult>>().toEqualTypeOf<
      z.output<typeof partUrlsResponseSchema>
    >();
  });

  it("статус составной загрузки", () => {
    expectTypeOf<MultipartStatus>().toEqualTypeOf<
      z.output<typeof multipartStatusResponseSchema>
    >();
  });

  it("ссылка на скачивание", () => {
    expectTypeOf<Serialized<GetDownloadUrlResult>>().toEqualTypeOf<
      z.output<typeof downloadUrlResponseSchema>
    >();
  });

  it("каталог", () => {
    expectTypeOf<DirectoryDto>().toEqualTypeOf<z.output<typeof directoryDtoSchema>>();
  });

  it("состояние и источник файла", () => {
    expectTypeOf<FileStatus>().toEqualTypeOf<z.output<typeof fileStatusSchema>>();
    expectTypeOf<UploadSource>().toEqualTypeOf<z.output<typeof uploadSourceSchema>>();
  });
});
