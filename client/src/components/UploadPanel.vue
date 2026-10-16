<script setup lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import { useFileDialog } from "@vueuse/core";
import {
  CloudUploadIcon,
  PaperclipIcon,
  ServerIcon,
  UploadIcon,
} from "@lucide/vue";
import DeleteFileDialog from "./DeleteFileDialog.vue";
import UploadListItem from "./UploadListItem.vue";
import type { FileDto } from "@/types/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useFileBrowser } from "@/composables/useFileBrowser";
import {
  MAX_UPLOAD_SIZE_MB,
  useUpload,
  type UploadRow,
} from "@/composables/useUpload";

defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const fileToDelete = ref<FileDto | null>(null);
const deleteOpen = ref(false);
const rowToDelete = shallowRef<UploadRow | null>(null);
function askDelete(row: UploadRow): void {
  const file = row.result.value;
  if (!file) return;
  rowToDelete.value = row;
  fileToDelete.value = file;
  deleteOpen.value = true;
}
async function deleteUpload(): Promise<void> {
  if (rowToDelete.value) upload.remove(rowToDelete.value);
}
const browser = useFileBrowser();
const upload = useUpload();
const targetDirectory = computed(
  () => upload.directory.value ?? browser.directory.value,
);
const { files, open: openFileDialog } = useFileDialog({
  multiple: true,
  reset: true,
});
watch(files, (value) => {
  if (value) upload.addFiles(Array.from(value), browser.directory.value);
});
function setMode(value: unknown): void {
  if (value === "server" || value === "presigned") upload.setMode(value);
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-xl">
      <DialogHeader>
        <DialogTitle>Загрузка файлов</DialogTitle>
        <DialogDescription
          >Выберите файлы и запустите загрузку. Одновременно загружаются до трёх
          файлов.</DialogDescription
        >
      </DialogHeader>
      <FieldGroup>
        <Field>
          <FieldLabel>Режим загрузки</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            :disabled="upload.uploading.value"
            :model-value="upload.mode.value"
            @update:model-value="setMode"
          >
            <ToggleGroupItem value="server"
              ><ServerIcon />Через сервер</ToggleGroupItem
            >
            <ToggleGroupItem value="presigned"
              ><CloudUploadIcon />Напрямую в S3</ToggleGroupItem
            >
          </ToggleGroup>
          <FieldDescription
            >Через сервер: до {{ MAX_UPLOAD_SIZE_MB }} МБ. Напрямую: сервер
            выбирает обычную или составную загрузку и параллельность
            частей.</FieldDescription
          >
        </Field>
        <Field>
          <FieldLabel>Каталог загрузки</FieldLabel>
          <p class="text-sm">{{ targetDirectory || "Корень" }}</p>
        </Field>
        <Button type="button" variant="outline" @click="openFileDialog()"
          ><PaperclipIcon />Выбрать файл</Button
        >
        <p aria-label="Сводка загрузок" role="status" class="text-sm">
          {{ upload.summary.value }}
        </p>
        <div
          class="max-h-80 space-y-4 overflow-y-auto"
          aria-label="Выбранные файлы"
        >
          <UploadListItem
            v-for="row in upload.rows.value"
            :key="row.id"
            :row="row"
            :mode="upload.mode.value"
            @remove="upload.remove(row)"
            @cancel="upload.cancelRow(row)"
            @delete="askDelete(row)"
            @retry="upload.retry(row, $event)"
          />
        </div>
      </FieldGroup>
      <DialogFooter>
        <DialogClose as-child
          ><Button variant="outline">Отмена</Button></DialogClose
        >
        <Button
          :disabled="!upload.hasSelected.value"
          @click="upload.submit(targetDirectory)"
          ><UploadIcon />Загрузить</Button
        >
      </DialogFooter>
    </DialogContent>
  </Dialog>
  <DeleteFileDialog
    v-model:open="deleteOpen"
    :file="fileToDelete"
    :remove="deleteUpload"
  />
</template>
