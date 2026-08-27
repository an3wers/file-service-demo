import { Router } from "express";
import { badRequest } from "../../errors.js";
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
      throw badRequest("FILE_REQUIRED", 'A file must be sent in the "file" field');
    }

    res.status(201).json(await service.uploadThroughServer(req.file, req.body.directory));
  },
);

// Step 1 of the direct-to-S3 flow: reserve the key and hand out a signed URL.
filesRouter.post("/presign-upload", validateBody(presignUploadSchema), async (req, res) => {
  res.status(201).json(await service.createPresignedUpload(req.body));
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
