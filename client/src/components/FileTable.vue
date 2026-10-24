<script setup lang="ts">
import { computed } from "vue";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  DownloadIcon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  PencilIcon,
  RefreshCwIcon,
  SearchXIcon,
  Trash2Icon,
  TriangleAlertIcon,
} from "@lucide/vue";
import type { DirectoryDto, FileDto, SortField } from "@/types/api";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatBytes, formatDate, iconForFile } from "@/lib/format";
import { useFileBrowser } from "@/composables/useFileBrowser";

const emit = defineEmits<{
  open: [file: FileDto];
  download: [file: FileDto];
  rename: [file: FileDto];
  move: [file: FileDto];
  remove: [file: FileDto];
  removeDirectory: [directory: DirectoryDto];
}>();

const browser = useFileBrowser();

const COLUMNS: { label: string; field: SortField; class: string }[] = [
  { label: "Название", field: "original_name", class: "" },
  { label: "Размер", field: "size_bytes", class: "w-32 text-right" },
  { label: "Дата загрузки", field: "created_at", class: "w-52" },
];

const isEmpty = computed(
  () =>
    !browser.loading.value &&
    !browser.error.value &&
    browser.files.value.length === 0 &&
    browser.directories.value.length === 0,
);

const skeletonRows = [0, 1, 2, 3, 4];
</script>

<template>
  <div class="flex flex-col gap-4">
    <Alert v-if="browser.error.value" variant="destructive">
      <TriangleAlertIcon />
      <AlertTitle>Не удалось загрузить список</AlertTitle>
      <AlertDescription>
        <p>{{ browser.error.value.message }}</p>
        <Button
          v-if="browser.error.value.directoryNotFound"
          variant="outline"
          size="sm"
          class="mt-2"
          @click="browser.openDirectory('')"
        >
          Перейти в корень
        </Button>
        <p v-if="browser.error.value.reference" class="opacity-80">
          {{ browser.error.value.reference }}
        </p>
        <Button
          v-if="browser.error.value.retryable"
          variant="outline"
          size="sm"
          class="mt-2"
          @click="browser.refresh()"
        >
          <RefreshCwIcon data-icon="inline-start" />
          Повторить
        </Button>
      </AlertDescription>
    </Alert>

    <div v-else class="min-w-0 rounded-md border">
      <Table
        class="min-w-[640px] table-fixed"
        :aria-busy="browser.loading.value"
      >
        <TableCaption class="sr-only"> Каталоги и файлы </TableCaption>
        <TableHeader>
          <TableRow>
            <TableHead
              v-for="column in COLUMNS"
              :key="column.label"
              :class="['h-12 px-4', column.class]"
              :aria-sort="
                browser.sort.value === column.field
                  ? browser.order.value === 'asc'
                    ? 'ascending'
                    : 'descending'
                  : 'none'
              "
            >
              <button
                type="button"
                class="flex items-center gap-1 rounded-sm hover:text-foreground/70 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                :class="column.field === 'size_bytes' ? 'ml-auto' : undefined"
                @click="browser.toggleSort(column.field)"
              >
                {{ column.label }}
                <ArrowUpIcon
                  v-if="
                    browser.sort.value === column.field &&
                    browser.order.value === 'asc'
                  "
                  class="size-3"
                />
                <ArrowDownIcon
                  v-else-if="browser.sort.value === column.field"
                  class="size-3"
                />
              </button>
            </TableHead>
            <TableHead class="h-12 w-44 px-4 text-right">
              <span class="sr-only">Действия</span>
            </TableHead>
          </TableRow>
        </TableHeader>

        <TableBody>
          <template v-if="browser.loading.value">
            <TableRow v-for="row in skeletonRows" :key="row">
              <TableCell v-for="cell in 4" :key="cell" class="h-14 px-4">
                <Skeleton class="h-5 w-full" />
              </TableCell>
            </TableRow>
          </template>

          <template v-else>
            <TableRow
              v-for="catalog in browser.directories.value"
              :key="`directory:${catalog.path}`"
              class="h-14 cursor-pointer hover:bg-muted/50"
              @click="browser.openDirectory(catalog.path)"
            >
              <TableCell class="px-4 font-medium">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-neutral-700 dark:text-neutral-400 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                  @click.stop="browser.openDirectory(catalog.path)"
                >
                  <FolderIcon
                    class="size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span class="truncate" :title="catalog.name">{{
                    catalog.name
                  }}</span>
                </button>
              </TableCell>
              <TableCell class="px-4 text-right text-muted-foreground">
                —
              </TableCell>
              <TableCell class="px-4 text-muted-foreground"> — </TableCell>
              <TableCell class="px-4 text-right">
                <span class="flex justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    class="text-destructive"
                    aria-label="Удалить каталог"
                    @click.stop="emit('removeDirectory', catalog)"
                  >
                    <Trash2Icon />
                  </Button>
                </span>
              </TableCell>
            </TableRow>
            <TableRow
              v-for="file in browser.files.value"
              :key="`file:${file.id}`"
              class="h-14 cursor-pointer hover:bg-muted/50"
              @click="emit('open', file)"
            >
              <TableCell class="px-4 font-medium">
                <button
                  type="button"
                  class="flex w-full min-w-0 items-center gap-2 rounded-sm text-left text-neutral-700 dark:text-neutral-400 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                  @click.stop="emit('open', file)"
                >
                  <component
                    :is="iconForFile(file)"
                    class="size-5 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span class="truncate" :title="file.name">{{
                    file.name
                  }}</span>
                </button>
              </TableCell>
              <TableCell
                class="px-4 text-right whitespace-nowrap text-muted-foreground"
              >
                {{ formatBytes(file.size) }}
              </TableCell>
              <TableCell class="px-4 whitespace-nowrap text-muted-foreground">
                {{ formatDate(file.createdAt) }}
              </TableCell>
              <TableCell class="px-4 text-right">
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
                    aria-label="Переименовать файл"
                    :disabled="file.status !== 'ready'"
                    @click.stop="emit('rename', file)"
                  >
                    <PencilIcon />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label="Переместить файл"
                    :disabled="file.status !== 'ready'"
                    @click.stop="emit('move', file)"
                  >
                    <FolderInputIcon />
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
          По запросу «{{ browser.search.value }}» в этой папке и её подпапках
          файлов нет.
        </EmptyDescription>
        <EmptyDescription v-else>
          Создайте каталог или загрузите файл в текущий каталог.
        </EmptyDescription>
      </EmptyHeader>
    </Empty>
  </div>
</template>
