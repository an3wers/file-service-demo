import { computed, ref, shallowReadonly, shallowRef } from "vue";
import type { FileDto } from "@/types/api";
import {
  createUploadOperation,
  type UploadMode,
  type UploadOperation,
} from "./createUploadOperation";

export type { UploadMode, UploadStage } from "./createUploadOperation";

export const MAX_UPLOAD_SIZE_MB = Number(
  import.meta.env.VITE_MAX_UPLOAD_SIZE_MB ?? "50",
);
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024;

const mode = ref<UploadMode>("server");
const selectedFile = shallowRef<File | null>(null);
const operation = shallowRef<UploadOperation | null>(null);
const uploading = computed(() => operation.value?.uploading.value ?? false);
const stage = computed(() => operation.value?.stage.value ?? "idle");
const sentBytes = computed(() => operation.value?.sentBytes.value ?? 0);
const totalBytes = computed(() => operation.value?.totalBytes.value ?? 0);
const partsTotal = computed(() => operation.value?.partsTotal.value ?? 0);
const partsDone = computed(() => operation.value?.partsDone.value ?? 0);
const percent = computed(() => operation.value?.percent.value ?? 100);
const cancellable = computed(() => operation.value?.cancellable.value ?? false);

function upload(file: File, directory: string): Promise<FileDto> {
  if (uploading.value) {
    return Promise.reject(new Error("Загрузка уже выполняется"));
  }

  operation.value = createUploadOperation(file, directory, mode.value);
  return operation.value.start();
}

function cancel(): void {
  operation.value?.cancel();
}

export function useUpload() {
  return {
    mode,
    selectedFile,
    operation: shallowReadonly(operation),
    uploading,
    stage,
    sentBytes,
    totalBytes,
    partsTotal,
    partsDone,
    percent,
    cancellable,
    upload,
    cancel,
  };
}
