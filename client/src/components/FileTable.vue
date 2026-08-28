<script setup lang="ts">
import { computed } from "vue"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  FolderIcon,
  FolderOpenIcon,
  RefreshCwIcon,
  SearchXIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "@lucide/vue"
import type { FileDto, SortField } from "@/types/api"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatBytes, formatDate, iconForFile, plural } from "@/lib/format"
import { useFileBrowser } from "@/composables/useFileBrowser"

const emit = defineEmits<{
  open: [file: FileDto]
  download: [file: FileDto]
  remove: [file: FileDto]
}>()

const browser = useFileBrowser()

// Порядок столбцов таблицы; `field` есть только у сортируемых.
const COLUMNS: { label: string; field?: SortField; class?: string }[] = [
  { label: "Имя", field: "original_name", class: "w-[40%]" },
  { label: "Размер", field: "size_bytes" },
  { label: "Тип" },
  { label: "Загружен", field: "created_at" },
  { label: "Источник" },
]

// Папки не смешиваем с результатами поиска: сервер их по `search` не фильтрует.
const showDirectories = computed(
  () => !browser.search.value && browser.directories.value.length > 0,
)

const isEmpty = computed(
  () =>
    !browser.loading.value &&
    !browser.error.value &&
    browser.files.value.length === 0 &&
    !showDirectories.value,
)

const skeletonRows = [0, 1, 2, 3, 4]
</script>

<template>
  <div class="flex flex-col gap-4">
    <Alert v-if="browser.error.value" variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>Не удалось загрузить список</AlertTitle>
      <AlertDescription>
        <p>{{ browser.error.value }}</p>
        <Button variant="outline" size="sm" class="mt-2" @click="browser.refresh()">
          <RefreshCwIcon data-icon="inline-start" />
          Повторить
        </Button>
      </AlertDescription>
    </Alert>

    <div v-else class="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead
              v-for="column in COLUMNS"
              :key="column.label"
              :class="column.class"
            >
              <button
                v-if="column.field"
                type="button"
                class="flex items-center gap-1 hover:text-foreground/70"
                @click="browser.toggleSort(column.field)"
              >
                {{ column.label }}
                <ArrowUpIcon
                  v-if="browser.sort.value === column.field && browser.order.value === 'asc'"
                  class="size-3"
                />
                <ArrowDownIcon
                  v-else-if="browser.sort.value === column.field"
                  class="size-3"
                />
              </button>
              <template v-else>{{ column.label }}</template>
            </TableHead>
            <TableHead class="w-24 text-right">
              <span class="sr-only">Действия</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          <template v-if="browser.loading.value">
            <TableRow v-for="row in skeletonRows" :key="row">
              <TableCell v-for="cell in 6" :key="cell">
                <Skeleton class="h-5 w-full" />
              </TableCell>
            </TableRow>
          </template>

          <template v-else>
            <!-- Папки всегда идут первыми: это файловый менеджер, а не плоский список. -->
            <TableRow
              v-for="folder in showDirectories ? browser.directories.value : []"
              :key="folder.path"
              class="cursor-pointer hover:bg-muted/50"
              @click="browser.openDirectory(folder.path)"
            >
              <TableCell class="font-medium">
                <span class="flex items-center gap-2">
                  <FolderIcon class="size-4 text-muted-foreground" />
                  <span class="truncate">{{ folder.name }}</span>
                </span>
              </TableCell>
              <TableCell :colspan="5" class="text-muted-foreground">
                <Badge variant="secondary">
                  {{ folder.fileCount }}
                  {{ plural(folder.fileCount, ["файл", "файла", "файлов"]) }}
                </Badge>
              </TableCell>
            </TableRow>

            <TableRow
              v-for="file in browser.files.value"
              :key="file.id"
              class="cursor-pointer hover:bg-muted/50"
              @click="emit('open', file)"
            >
              <TableCell class="font-medium">
                <span class="flex items-center gap-2">
                  <component :is="iconForFile(file)" class="size-4 text-muted-foreground" />
                  <span class="truncate" :title="file.name">{{ file.name }}</span>
                </span>
              </TableCell>
              <TableCell class="whitespace-nowrap text-muted-foreground">
                {{ formatBytes(file.size) }}
              </TableCell>
              <TableCell>
                <Badge v-if="file.extension" variant="outline">{{ file.extension }}</Badge>
                <span v-else class="text-muted-foreground">—</span>
              </TableCell>
              <TableCell class="whitespace-nowrap text-muted-foreground">
                {{ formatDate(file.createdAt) }}
              </TableCell>
              <TableCell>
                <Badge :variant="file.uploadSource === 'server' ? 'secondary' : 'outline'">
                  {{ file.uploadSource === "server" ? "server" : "presigned" }}
                </Badge>
              </TableCell>
              <TableCell class="text-right">
                <span class="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Скачать файл"
                    @click.stop="emit('download', file)"
                  >
                    <DownloadIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    class="text-destructive"
                    aria-label="Удалить файл"
                    @click.stop="emit('remove', file)"
                  >
                    <Trash2Icon />
                  </Button>
                </span>
              </TableCell>
            </TableRow>
          </template>
        </TableBody>
      </Table>
    </div>

    <Empty v-if="isEmpty" class="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <SearchXIcon v-if="browser.search.value" />
          <FolderOpenIcon v-else />
        </EmptyMedia>
        <EmptyTitle>
          {{ browser.search.value ? "Ничего не найдено" : "Здесь пока пусто" }}
        </EmptyTitle>
        <EmptyDescription v-if="browser.search.value">
          По запросу «{{ browser.search.value }}» в этой папке и её подпапках файлов нет.
        </EmptyDescription>
        <EmptyDescription v-else>
          Папки выводятся из путей уже загруженных файлов, поэтому пустых папок не
          существует — папка появляется вместе с первым файлом в ней.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
