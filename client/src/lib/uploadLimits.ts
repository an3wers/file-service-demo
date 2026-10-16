export const MAX_UPLOAD_SIZE_MB = Number(
  import.meta.env.VITE_MAX_UPLOAD_SIZE_MB ?? "50",
);
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

export function serverUploadSizeError(file: File): string | null {
  return file.size > MAX_UPLOAD_SIZE_BYTES
    ? `Файл превышает лимит ${MAX_UPLOAD_SIZE_MB} МБ для загрузки через сервер. Выберите прямую загрузку.`
    : null;
}
