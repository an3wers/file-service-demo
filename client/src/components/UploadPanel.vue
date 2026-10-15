<script setup lang="ts">
import { ref, watch } from "vue";
import { useFileDialog } from "@vueuse/core";
import {
  CloudUploadIcon,
  PaperclipIcon,
  ServerIcon,
  UploadIcon,
} from "@lucide/vue";
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
import { Progress } from "@/components/ui/progress";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { formatBytes } from "@/lib/format";
import { useFileBrowser } from "@/composables/useFileBrowser";
import {
  MAX_UPLOAD_SIZE_MB,
  useUpload,
  type UploadRow,
} from "@/composables/useUpload";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const browser = useFileBrowser();
const upload = useUpload();
const targetDirectory = ref(browser.directory.value);
watch(
  () => props.open,
  (open) => {
    if (open) targetDirectory.value = browser.directory.value;
  },
);
const { files, open: openFileDialog } = useFileDialog({
  multiple: true,
  reset: true,
});
watch(files, (value) => {
  if (value) upload.addFiles(Array.from(value));
});
const STAGE_LABELS = {
  idle: "Ожидает",
  presigning: "Готовим ссылку…",
  sending: "Отправляем…",
  processing: "Обрабатываем…",
  completing: "Подтверждаем…",
  cancelling: "Отменяем…",
};
function label(row: UploadRow): string {
  if (row.state.value === "selected") return "Выбран";
  if (row.state.value === "queued") return "Ожидает";
  if (row.state.value === "cancelled") return "Отменено";
  const outcome = row.operation.value?.outcome.value;
  if (outcome?.status === "succeeded") return "Готово";
  if (outcome?.status === "failed") return "Ошибка";
  if (outcome?.status === "cancelled") return "Отменено";
  return STAGE_LABELS[row.operation.value?.stage.value ?? "idle"];
}
function setMode(value: unknown): void {
  if (value === "server" || value === "presigned") upload.mode.value = value;
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
          <div
            v-for="row in upload.rows.value"
            :key="row.id"
            data-testid="upload-row"
            class="space-y-2 rounded-md border p-3"
          >
            <div class="flex items-center justify-between gap-3">
              <span
                data-file-name
                class="min-w-0 truncate text-sm"
                :title="row.file.name"
                >{{ row.file.name }}</span
              >
              <span class="text-sm text-muted-foreground">{{
                formatBytes(row.file.size)
              }}</span>
            </div>
            <p v-if="row.operation.value" class="text-xs text-muted-foreground">
              {{ row.operation.value.directory || "Корень" }} ·
              {{
                row.operation.value.mode === "server"
                  ? "Через сервер"
                  : "Напрямую в S3"
              }}
            </p>
            <div class="flex items-center justify-between gap-2 text-sm">
              <span>{{ label(row) }}</span>
              <span
                v-if="
                  row.operation.value &&
                  row.state.value !== 'queued' &&
                  row.state.value !== 'cancelled'
                "
                >{{ row.operation.value.percent.value }}%</span
              >
              <Button
                v-if="row.state.value === 'selected'"
                variant="outline"
                size="sm"
                @click="upload.remove(row)"
                >Убрать</Button
              >
              <Button
                v-if="
                  row.state.value === 'queued' || row.state.value === 'active'
                "
                variant="outline"
                size="sm"
                :disabled="
                  row.state.value === 'active' &&
                  !row.operation.value?.cancellable.value
                "
                @click="upload.cancelRow(row)"
                >Отменить</Button
              >
            </div>
            <Button
              v-if="
                (row.state.value === 'finished' ||
                  row.state.value === 'cancelled') &&
                row.operation.value &&
                row.operation.value.outcome.value?.status !== 'succeeded'
              "
              variant="outline"
              size="sm"
              :disabled="row.operation.value?.uploading.value"
              @click="
                row.operation.value?.unresolved.value
                  ? upload.checkResult(row)
                  : upload.retry(row)
              "
              >{{
                row.operation.value?.unresolved.value
                  ? "Выяснить результат"
                  : "Повторить"
              }}</Button
            >
            <ToggleGroup
              v-if="
                row.state.value === 'finished' &&
                row.operation.value?.outcome.value?.status !== 'succeeded'
              "
              type="single"
              variant="outline"
              aria-label="Режим повтора"
              :disabled="
                row.operation.value?.unresolved.value ||
                row.operation.value?.uploading.value
              "
              :model-value="row.operation.value?.mode"
              @update:model-value="
                (value) => {
                  if (value === 'server' || value === 'presigned')
                    row.operation.value?.changeMode(value);
                }
              "
            >
              <ToggleGroupItem value="server">Через сервер</ToggleGroupItem>
              <ToggleGroupItem value="presigned">Напрямую в S3</ToggleGroupItem>
            </ToggleGroup>
            <template
              v-if="row.operation.value && row.state.value === 'active'"
            >
              <Progress
                :aria-label="`Прогресс ${row.file.name}`"
                :model-value="row.operation.value.percent.value"
                :class="
                  row.operation.value.stage.value !== 'sending'
                    ? 'animate-pulse'
                    : undefined
                "
              />
              <p class="text-xs text-muted-foreground">
                {{ formatBytes(row.operation.value.sentBytes.value) }} из
                {{ formatBytes(row.operation.value.totalBytes.value)
                }}<template v-if="row.operation.value.partsTotal.value">
                  · частей: {{ row.operation.value.partsDone.value }} из
                  {{ row.operation.value.partsTotal.value }}</template
                >
              </p>
            </template>
            <p
              v-if="row.operation.value?.outcome.value?.status === 'failed'"
              role="alert"
              class="text-sm text-destructive"
            >
              {{ row.operation.value.outcome.value.message }}
            </p>
          </div>
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
</template>
