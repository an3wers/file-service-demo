<script setup lang="ts">
import { computed, ref } from "vue";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { formatBytes } from "@/lib/format";
import { serverUploadSizeError } from "@/lib/uploadLimits";
import type { UploadMode, UploadRow } from "@/composables/useUpload";

const props = defineProps<{ row: UploadRow; mode: UploadMode }>();
const emit = defineEmits<{
  remove: [];
  cancel: [];
  delete: [];
  retry: [file?: File];
}>();
const input = ref<HTMLInputElement | null>(null);
const labels = {
  selected: "Выбран",
  uploading: "Загружается",
  succeeded: "Успех",
  cancelled: "Отменено",
  failed: "Ошибка загрузки",
};
const error = computed(
  () =>
    props.row.message.value ??
    (props.row.status.value === "selected" && props.mode === "server"
      ? serverUploadSizeError(props.row.file)
      : null),
);
const percent = computed(() =>
  props.row.status.value === "succeeded"
    ? 100
    : Math.min(99, props.row.operation.value?.percent.value ?? 0),
);
function retry(): void {
  if (props.row.source) emit("retry");
  else input.value?.click();
}
function selectFile(event: Event): void {
  const element = event.target as HTMLInputElement;
  const file = element.files?.[0];
  if (file) emit("retry", file);
  element.value = "";
}
</script>

<template>
  <div data-testid="upload-row" class="space-y-2 rounded-md border p-3">
    <div class="flex items-center justify-between gap-3">
      <span
        data-file-name
        class="min-w-0 truncate text-sm"
        :title="row.result.value?.name ?? row.file.name"
        >{{ row.result.value?.name ?? row.file.name }}</span
      >
      <span class="text-sm text-muted-foreground">{{
        formatBytes(row.file.size)
      }}</span>
    </div>
    <p
      v-if="row.status.value !== 'selected'"
      class="text-xs text-muted-foreground"
    >
      {{ (row.result.value?.directory ?? row.targetDirectory) || "Корень" }} ·
      {{
        (row.operation.value?.mode ?? row.uploadMode) === "server"
          ? "Через сервер"
          : "Напрямую в S3"
      }}
    </p>
    <div class="flex items-center justify-between gap-2 text-sm">
      <span role="status">{{ labels[row.status.value] }}</span>
      <span
        v-if="
          row.status.value === 'uploading' || row.status.value === 'succeeded'
        "
        >{{ percent }}%</span
      >
      <Button
        v-if="row.status.value === 'uploading' && row.intent.value === 'upload'"
        variant="outline"
        size="sm"
        @click="emit('cancel')"
        >Отменить</Button
      >
    </div>
    <div class="flex gap-2">
      <Button
        v-if="row.status.value !== 'uploading' && row.intent.value !== 'remove'"
        variant="outline"
        size="sm"
        @click="
          row.status.value === 'succeeded' ? emit('delete') : emit('remove')
        "
        >Удалить</Button
      >
      <Button
        v-if="
          (row.status.value === 'failed' || row.status.value === 'cancelled') &&
          !row.pending.value
        "
        variant="outline"
        size="sm"
        @click="retry"
        >Повторить</Button
      >
    </div>
    <input
      ref="input"
      type="file"
      class="sr-only"
      tabindex="-1"
      :aria-label="`Исходный файл для повтора ${row.file.name}`"
      @change="selectFile"
    />
    <template v-if="row.status.value === 'uploading'">
      <Progress
        :aria-label="`Прогресс ${row.file.name}`"
        :model-value="percent"
        :class="
          row.operation.value?.stage.value !== 'sending'
            ? 'animate-pulse'
            : undefined
        "
      />
      <p v-if="row.operation.value" class="text-xs text-muted-foreground">
        {{ formatBytes(row.operation.value.sentBytes.value) }} из
        {{ formatBytes(row.operation.value.totalBytes.value) }}
        <template v-if="row.operation.value.partsTotal.value">
          · частей: {{ row.operation.value.partsDone.value }} из
          {{ row.operation.value.partsTotal.value }}</template
        >
      </p>
    </template>
    <p v-if="error" role="alert" class="text-sm text-destructive">
      {{ error }}
    </p>
  </div>
</template>
