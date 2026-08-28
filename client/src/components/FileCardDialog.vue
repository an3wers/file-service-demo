<script setup lang="ts">
import { ref, watch } from "vue"
import type { FileDto } from "@/types/api"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { getFile } from "@/api/files"
import { errorMessage } from "@/lib/errors"
import { formatBytes, formatDate } from "@/lib/format"
import { useFileActions } from "@/composables/useFileActions"

const props = defineProps<{ file: FileDto | null; open: boolean }>()

const emit = defineEmits<{
  "update:open": [value: boolean]
  download: [file: FileDto]
  remove: [file: FileDto]
}>()

const actions = useFileActions()

// Данные в списке могут быть устаревшими, поэтому карточку дозапрашиваем.
const fresh = ref<FileDto | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

watch(
  () => [props.open, props.file?.id] as const,
  async ([open, id]) => {
    if (!open || !id) {
      return
    }

    fresh.value = null
    error.value = null
    loading.value = true

    try {
      fresh.value = await getFile(id, true)
    } catch (cause) {
      error.value = errorMessage(cause, "Не удалось загрузить карточку файла")
    } finally {
      loading.value = false
    }
  },
  { immediate: true },
)

function download(): void {
  const file = fresh.value

  if (!file) {
    return
  }

  // `downloadUrl` уже пришёл вместе с карточкой — второй запрос не нужен.
  if (file.downloadUrl) {
    actions.downloadByUrl(file.downloadUrl)
    return
  }

  emit("download", file)
}
</script>

<template>
  <Dialog :open="open" @update:open="emit('update:open', $event)">
    <DialogContent class="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle class="break-all">{{ file?.name ?? "Файл" }}</DialogTitle>
        <DialogDescription>
          {{ file?.directory ? `Директория: ${file.directory}` : "Директория: корень" }}
        </DialogDescription>
      </DialogHeader>

      <div v-if="loading" class="flex flex-col gap-2">
        <Skeleton v-for="row in 6" :key="row" class="h-5 w-full" />
      </div>

      <p v-else-if="error" class="text-destructive text-sm">{{ error }}</p>

      <dl
        v-else-if="fresh"
        class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm"
      >
        <dt class="text-muted-foreground">ID</dt>
        <dd class="font-mono text-xs break-all">{{ fresh.id }}</dd>

        <dt class="text-muted-foreground">Директория</dt>
        <dd class="break-all">{{ fresh.directory || "Корень" }}</dd>

        <dt class="text-muted-foreground">Расширение</dt>
        <dd>{{ fresh.extension || "—" }}</dd>

        <dt class="text-muted-foreground">Тип содержимого</dt>
        <dd class="break-all">{{ fresh.contentType }}</dd>

        <dt class="text-muted-foreground">Размер</dt>
        <dd>{{ formatBytes(fresh.size) }}</dd>

        <dt class="text-muted-foreground">ETag</dt>
        <dd class="font-mono text-xs break-all">{{ fresh.etag ?? "—" }}</dd>

        <dt class="text-muted-foreground">Статус</dt>
        <dd>
          <Badge :variant="fresh.status === 'ready' ? 'secondary' : 'outline'">
            {{ fresh.status }}
          </Badge>
        </dd>

        <dt class="text-muted-foreground">Источник</dt>
        <dd>
          <Badge variant="outline">{{ fresh.uploadSource }}</Badge>
        </dd>

        <dt class="text-muted-foreground">Бакет</dt>
        <dd class="break-all">{{ fresh.bucket }}</dd>

        <dt class="text-muted-foreground">Ключ объекта</dt>
        <dd class="font-mono text-xs break-all">{{ fresh.key }}</dd>

        <dt class="text-muted-foreground">Создан</dt>
        <dd>{{ formatDate(fresh.createdAt) }}</dd>

        <dt class="text-muted-foreground">Обновлён</dt>
        <dd>{{ formatDate(fresh.updatedAt) }}</dd>
      </dl>

      <DialogFooter>
        <Button
          variant="outline"
          :disabled="!fresh || fresh.status !== 'ready'"
          @click="download"
        >
          Скачать
        </Button>
        <Button
          variant="destructive"
          :disabled="!fresh"
          @click="fresh && emit('remove', fresh)"
        >
          Удалить
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
