<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useFileDialog } from "@vueuse/core";
import {
  CloudUploadIcon,
  PaperclipIcon,
  ServerIcon,
  UploadIcon,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import type { UploadMode } from "@/composables/useUpload";
import { Badge } from "@/components/ui/badge";
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
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isApiError } from "@/api/client";
import { errorMessage } from "@/lib/errors";
import {
  MAX_DIRECTORY_BYTES,
  checkDirectory,
  directoryByteLength,
} from "@/lib/directory";
import { formatBytes } from "@/lib/format";
import { useFileBrowser } from "@/composables/useFileBrowser";
import {
  MAX_UPLOAD_SIZE_BYTES,
  MAX_UPLOAD_SIZE_MB,
  useUpload,
} from "@/composables/useUpload";

const props = defineProps<{ open: boolean }>();

const emit = defineEmits<{
  "update:open": [value: boolean];
}>();

const browser = useFileBrowser();
const upload = useUpload();

const directoryInput = ref(browser.directory.value);
// Пока пользователь не тронул поле, оно следует за текущей папкой браузера.
const dirty = ref(false);

watch(browser.directory, (value) => {
  if (!dirty.value) {
    directoryInput.value = value;
  }
});

// Диалог живёт между открытиями, поэтому каждое открытие начинаем с текущей папки.
watch(
  () => props.open,
  (open) => {
    if (open) {
      useCurrentDirectory();
    }
  },
);

const check = computed(() => checkDirectory(directoryInput.value));
const directoryError = computed(() =>
  check.value.ok ? null : check.value.message,
);
const directoryBytes = computed(() =>
  directoryByteLength(directoryInput.value),
);

const {
  files,
  open: openFileDialog,
  reset: resetFileDialog,
} = useFileDialog({
  multiple: false,
  // Без reset повторный выбор того же файла не вызовет onChange.
  reset: true,
});

watch(files, (value) => {
  upload.selectedFile.value = value?.[0] ?? null;
});

const selected = computed(() => upload.selectedFile.value);

const oversized = computed(
  () =>
    upload.mode.value === "server" &&
    selected.value !== null &&
    selected.value.size > MAX_UPLOAD_SIZE_BYTES,
);

const STAGE_LABELS: Record<string, string> = {
  presigning: "Готовим ссылку…",
  sending: "Отправляем…",
  completing: "Подтверждаем…",
};

const submitLabel = computed(() =>
  upload.uploading.value
    ? (STAGE_LABELS[upload.stage.value] ?? "Отправляем…")
    : "Загрузить",
);

function setMode(value: unknown): void {
  // ToggleGroup в режиме single умеет снимать выбор — пустое значение игнорируем.
  if (value === "server" || value === "presigned") {
    upload.mode.value = value as UploadMode;
  }
}

function useCurrentDirectory(): void {
  directoryInput.value = browser.directory.value;
  dirty.value = false;
}

async function submit(): Promise<void> {
  const file = selected.value;
  const directory = check.value;

  if (!file || !directory.ok || upload.uploading.value) {
    return;
  }

  try {
    // Отправляем нормализованное значение — оно совпадёт с тем, что вычислит сервер.
    const result = await upload.upload(file, directory.value);

    toast.success(`Файл «${result.name}» загружен`, {
      description:
        result.uploadSource === "server"
          ? "Через сервер"
          : "Напрямую в S3 (presigned)",
    });

    upload.selectedFile.value = null;
    resetFileDialog();
    emit("update:open", false);

    // Результат должен быть виден: если файл ушёл не в текущую папку — переходим в неё.
    if (result.directory !== browser.directory.value) {
      browser.openDirectory(result.directory);
    } else {
      browser.refresh();
    }
  } catch (error) {
    if (isApiError(error) && error.status === 413) {
      toast.error(errorMessage(error), {
        description:
          "Переключитесь на режим «Напрямую в S3» — на него лимит не действует",
      });
      return;
    }

    if (isApiError(error) && error.code === "S3_UPLOAD_FAILED") {
      toast.error(errorMessage(error), {
        description:
          "PUT идёт в S3 мимо прокси: проверьте CORS бакета (npm run s3:cors) и что клиент открыт на порту 5173",
      });
      return;
    }

    toast.error(errorMessage(error, "Не удалось загрузить файл"));
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Загрузка файла</DialogTitle>
        <DialogDescription>
          Два режима: через API или напрямую в объектное хранилище по
          presigned-ссылке.
        </DialogDescription>
      </DialogHeader>

      <FieldGroup>
        <Field>
          <FieldLabel>Режим загрузки</FieldLabel>
          <ToggleGroup
            type="single"
            variant="outline"
            :model-value="upload.mode.value"
            @update:model-value="setMode"
          >
            <ToggleGroupItem value="server">
              <ServerIcon />
              Через сервер
            </ToggleGroupItem>
            <ToggleGroupItem value="presigned">
              <CloudUploadIcon />
              Напрямую в S3
            </ToggleGroupItem>
          </ToggleGroup>
          <FieldDescription>
            <p>
              Через сервер: байты идут через API, лимит
              {{ MAX_UPLOAD_SIZE_MB }} МБ.
            </p>
            <p>
              Напрямую: presigned-PUT в хранилище и подтверждение загрузки,
              лимита нет.
            </p>
          </FieldDescription>
        </Field>

        <Field :data-invalid="directoryError ? true : undefined">
          <FieldLabel for="directory">Директория</FieldLabel>
          <Input
            id="directory"
            v-model="directoryInput"
            placeholder="docs/reports"
            :aria-invalid="directoryError ? true : undefined"
            @input="dirty = true"
          />
          <FieldDescription>
            Пустое поле — корень хранилища. {{ directoryBytes }}/{{
              MAX_DIRECTORY_BYTES
            }}
            байт.
            <button
              v-if="directoryInput !== browser.directory.value"
              type="button"
              class="underline underline-offset-4 hover:text-primary"
              @click="useCurrentDirectory"
            >
              Текущая папка
            </button>
          </FieldDescription>
          <FieldError v-if="directoryError">{{ directoryError }}</FieldError>
        </Field>

        <Field>
          <FieldLabel>Файл</FieldLabel>
          <div class="flex flex-wrap items-center gap-3">
            <Button type="button" variant="outline" @click="openFileDialog()">
              <PaperclipIcon data-icon="inline-start" />
              Выбрать файл
            </Button>
            <span
              v-if="selected"
              class="flex min-w-0 items-center gap-2 text-sm"
            >
              <span class="truncate" :title="selected.name">{{
                selected.name
              }}</span>
              <Badge variant="outline">{{ formatBytes(selected.size) }}</Badge>
            </span>
            <span v-else class="text-muted-foreground text-sm"
              >Файл не выбран</span
            >
          </div>
          <FieldDescription v-if="oversized" class="text-destructive">
            Файл больше {{ MAX_UPLOAD_SIZE_MB }} МБ — сервер, скорее всего,
            ответит 413. Отправку это не блокирует.
          </FieldDescription>
        </Field>
      </FieldGroup>

      <DialogFooter>
        <DialogClose as-child>
          <Button variant="outline">Отмена</Button>
        </DialogClose>
        <Button
          :disabled="!selected || !!directoryError || upload.uploading.value"
          @click="submit"
        >
          <Spinner v-if="upload.uploading.value" data-icon="inline-start" />
          <UploadIcon v-else data-icon="inline-start" />
          {{ submitLabel }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
