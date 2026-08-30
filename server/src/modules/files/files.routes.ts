import { Router } from "express";
import { ERROR_CODES, badRequest } from "../../errors.js";
import { upload } from "../../middleware/upload.js";
import {
  validateBody,
  validateParams,
  validateQuery,
  validatedParams,
  validatedQuery,
} from "../../middleware/validate.js";
import {
  directoriesQuerySchema,
  downloadUrlQuerySchema,
  fileCardQuerySchema,
  idParamsSchema,
  listFilesQuerySchema,
  partUrlsSchema,
  presignUploadSchema,
  uploadBodySchema,
} from "./files.schemas.js";
import type {
  DirectoriesQuery,
  DownloadUrlQuery,
  FileCardQuery,
  IdParams,
  ListFilesQuery,
} from "./files.schemas.js";
import * as service from "./files.service.js";

export const filesRouter = Router();

// Upload proxied through the server (multipart/form-data).
filesRouter.post(
  "/",
  upload.single("file"),
  validateBody(uploadBodySchema),
  async (req, res) => {
    if (!req.file) {
      throw badRequest(
        ERROR_CODES.FILE_REQUIRED,
        'A file must be sent in the "file" field',
      );
    }

    res.status(201).json(await service.uploadThroughServer(req.file, req.body.directory));
  },
);

// Step 1 of the direct-to-S3 flow: reserve the key and hand out a signed URL —
// or, past the multipart threshold, a split plan with the first batch of them.
filesRouter.post("/presign-upload", validateBody(presignUploadSchema), async (req, res) => {
  res.status(201).json(await service.createPresignedUpload(req.body));
});

// A further batch of part URLs, and the way an expired one gets reissued.
filesRouter.post(
  "/:id/multipart/part-urls",
  validateParams(idParamsSchema),
  validateBody(partUrlsSchema),
  async (req, res) => {
    const { id } = validatedParams<IdParams>(res);

    res.json(await service.getPartUrls(id, req.body));
  },
);

// What S3 already holds, so an interrupted upload can pick up where it stopped.
filesRouter.get("/:id/multipart", validateParams(idParamsSchema), async (_req, res) => {
  const { id } = validatedParams<IdParams>(res);

  res.json(await service.getMultipartStatus(id));
});

filesRouter.get("/", validateQuery(listFilesQuerySchema), async (_req, res) => {
  res.json(await service.listFiles(validatedQuery<ListFilesQuery>(res)));
});

filesRouter.get(
  "/:id",
  validateParams(idParamsSchema),
  validateQuery(fileCardQuerySchema),
  async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);
    const { withUrl } = validatedQuery<FileCardQuery>(res);

    res.json(await service.getFileCard(id, withUrl));
  },
);

// Step 2 of the direct-to-S3 flow: verify against S3 and record the real size.
// Multipart uploads are assembled here too, so the client confirms the same way
// whichever strategy it used.
filesRouter.post("/:id/complete", validateParams(idParamsSchema), async (_req, res) => {
  const { id } = validatedParams<IdParams>(res);

  res.json(await service.completeUpload(id));
});

filesRouter.get(
  "/:id/download-url",
  validateParams(idParamsSchema),
  validateQuery(downloadUrlQuerySchema),
  async (_req, res) => {
    const { id } = validatedParams<IdParams>(res);

    res.json(await service.getDownloadUrl(id, validatedQuery<DownloadUrlQuery>(res)));
  },
);

filesRouter.delete("/:id", validateParams(idParamsSchema), async (_req, res) => {
  const { id } = validatedParams<IdParams>(res);

  await service.deleteFile(id);
  res.status(204).end();
});

export const directoriesRouter = Router();

directoriesRouter.get("/", validateQuery(directoriesQuerySchema), async (_req, res) => {
  const { parent } = validatedQuery<DirectoriesQuery>(res);

  res.json(await service.listDirectories(parent));
});
