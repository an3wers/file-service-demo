<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useFileDialog } from "@vueuse/core";
import {
  CloudUploadIcon,
  PaperclipIcon,
  ServerIcon,
  UploadIcon,
  XIcon,
} from "@lucide/vue";
import { toast } from "vue-sonner";
import type { UploadSource } from "@/types/api";
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
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { isAbortError, isApiError } from "@/api/client";
import { errorMessage, isRetryable, requestReference } from "@/lib/errors";
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

// Способ загрузки выбирает сервер (по размеру файла), поэтому в тосте показываем
// то, что он вернул, а не то, что просил клиент.
const SOURCE_LABELS: Record<UploadSource, string> = {
  server: "Через сервер",
  presigned: "Напрямую в S3 (presigned)",
  multipart: "Частями напрямую в S3 (multipart)",
};

const STAGE_LABELS: Record<string, string> = {
  presigning: "Готовим ссылку…",
  sending: "Отправляем…",
  processing: "Обрабатываем…",
  completing: "Подтверждаем…",
};

const stageLabel = computed(
  () => STAGE_LABELS[upload.stage.value] ?? "Отправляем…",
);

// Подробности стадии живут в блоке прогресса — на кнопке они бы дублировались.
const submitLabel = computed(() =>
  upload.uploading.value ? "Загрузка…" : "Загрузить",
);

// Проценты движутся только на стадии отправки тела — на остальных шкала замирает.
const indeterminate = computed(
  () => upload.uploading.value && upload.stage.value !== "sending",
);

// Ноль частей — обычная загрузка целиком: счётчику в таком случае нечего показывать.
const partsLabel = computed(() =>
  upload.partsTotal.value > 0
    ? `часть ${Math.min(upload.partsDone.value + 1, upload.partsTotal.value)} из ${upload.partsTotal.value}`
    : null,
);

const waitingForServer = computed(
  () =>
    upload.stage.value === "processing" || upload.stage.value === "completing",
);

function setMode(value: unknown): void {
  // ToggleGroup в режиме single умеет снимать выбор — пустое значение игнорируем.
  if (value === "server" || value === "presigned") {
    upload.mode.value = value as UploadMode;
  }
}

// Пока байты идут, закрытие диалога только прячет прогресс — загрузка не прервётся.
function blockWhileUploading(event: Event): void {
  if (upload.uploading.value) {
    event.preventDefault();
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
      description: SOURCE_LABELS[result.uploadSource],
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
    if (isAbortError(error)) {
      // Файл и диалог оставляем как есть — отмена обычно означает «выберу другой».
      toast.info("Загрузка отменена");
      return;
    }

    // Ветка по коду, а не по статусу: код гарантирован сервером, а 413 в будущем
    // может прийти и от чего-то другого.
    if (isApiError(error) && error.code === "PAYLOAD_TOO_LARGE") {
      toast.error(errorMessage(error), {
        description:
          upload.mode.value === "server"
            ? `Через сервер проходит не больше ${MAX_UPLOAD_SIZE_MB} МБ — переключитесь на режим «Напрямую в S3»`
            : "Файл больше потолка хранилища (MAX_OBJECT_SIZE_GB на сервере) — его не примет ни один режим",
      });
      return;
    }

    // 429 здесь — про занятые слоты, а не про частоту запросов: кнопки «Повторить»
    // быть не должно, повтор упрётся в тот же слот (`isRetryable` его и не даёт).
    if (isApiError(error) && error.code === "TOO_MANY_ACTIVE_UPLOADS") {
      toast.error(errorMessage(error), {
        description:
          "Место освобождает завершение или отмена одной из идущих загрузок частями",
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

    toast.error(errorMessage(error, "Не удалось загрузить файл"), {
      // Номер обращения — единственное, по чему причину 5xx найдут в логе сервера.
      description: requestReference(error) ?? undefined,
      action: isRetryable(error)
        ? { label: "Повторить", onClick: () => void submit() }
        : undefined,
    });
  }
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent
      class="sm:max-w-lg"
      :show-close-button="!upload.uploading.value"
      @escape-key-down="blockWhileUploading"
      @interact-outside="blockWhileUploading"
    >
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
            :disabled="upload.uploading.value"
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
              лимита нет. Большие файлы сервер сам разложит на части и пришлёт
              план — грузить их можно параллельно.
            </p>
          </FieldDescription>
        </Field>

        <Field :data-invalid="directoryError ? true : undefined">
          <FieldLabel for="directory">Директория</FieldLabel>
          <Input
            id="directory"
            v-model="directoryInput"
            placeholder="docs/reports"
            :disabled="upload.uploading.value"
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
            <Button
              type="button"
              variant="outline"
              :disabled="upload.uploading.value"
              @click="openFileDialog()"
            >
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

        <Field v-if="upload.uploading.value">
          <div class="flex items-center justify-between gap-2 text-sm">
            <span>{{ stageLabel }}</span>
            <span class="text-muted-foreground tabular-nums">
              {{ upload.percent.value }}%
            </span>
          </div>
          <Progress
            aria-label="Прогресс загрузки"
            :model-value="upload.percent.value"
            :class="indeterminate ? 'animate-pulse' : undefined"
          />
          <FieldDescription>
            {{ formatBytes(upload.sentBytes.value) }} из
            {{ formatBytes(upload.totalBytes.value) }}
            <template v-if="partsLabel"> — {{ partsLabel }} </template>
            <template v-if="waitingForServer"> — ждём ответ </template>
          </FieldDescription>
        </Field>
      </FieldGroup>

      <DialogFooter>
        <Button
          v-if="upload.uploading.value"
          variant="outline"
          :disabled="!upload.cancellable.value"
          @click="upload.cancel"
        >
          <XIcon data-icon="inline-start" />
          Отменить
        </Button>
        <DialogClose v-else as-child>
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
