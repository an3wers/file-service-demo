<script setup lang="ts">
import { computed, ref } from "vue";
import { SearchIcon, Trash2Icon, UploadIcon } from "@lucide/vue";
import type { DirectoryDto, FileDto } from "@/types/api";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  CardAction,
} from "@/components/ui/card";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import DeleteDirectoryDialog from "./DeleteDirectoryDialog.vue";
import DeleteFileDialog from "./DeleteFileDialog.vue";
import DirectoryBreadcrumbs from "./DirectoryBreadcrumbs.vue";
import FileCardDialog from "./FileCardDialog.vue";
import FileTable from "./FileTable.vue";
import CreateDirectoryDialog from "./CreateDirectoryDialog.vue";
import MoveDialog from "./MoveDialog.vue";
import RenameDialog from "./RenameDialog.vue";
import UploadPanel from "./UploadPanel.vue";
import {
  useDialogTarget,
  type DialogTarget,
} from "@/composables/useDialogTarget";
import { useFileActions } from "@/composables/useFileActions";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { useFileBrowserRoute } from "@/composables/useFileBrowserRoute";
import { useUpload } from "@/composables/useUpload";

const browser = useFileBrowser();
const actions = useFileActions();
const upload = useUpload();

useFileBrowserRoute();

const card = useDialogTarget<FileDto>();
const fileDeletion = useDialogTarget<FileDto>();
const fileRename = useDialogTarget<FileDto>();
const fileMove = useDialogTarget<FileDto>();
const uploadOpen = ref(false);
const createOpen = ref(false);
const directoryDeletion =
  useDialogTarget<Pick<DirectoryDto, "name" | "path">>();
const directoryRename = useDialogTarget<DirectoryDto>();
const directoryMove = useDialogTarget<DirectoryDto>();

const limitValue = computed({
  get: () => String(browser.limit.value),
  set: (value: string) => browser.setLimit(Number(value)),
});

const totalPages = computed(() => browser.pagination.value?.totalPages ?? 1);
const total = computed(() => browser.pagination.value?.total ?? 0);

function fromCard(dialog: DialogTarget<FileDto>) {
  return (file: FileDto) => {
    card.open = false;
    dialog.ask(file);
  };
}

const askDelete = fromCard(fileDeletion);
const askRename = fromCard(fileRename);
const askMove = fromCard(fileMove);

async function renameSelected(name: string): Promise<void> {
  if (fileRename.target)
    fileRename.target = await actions.rename(fileRename.target, name);
}

async function moveSelected(directory: string): Promise<void> {
  if (fileMove.target)
    fileMove.target = await actions.move(fileMove.target, directory);
}

async function renameSelectedDirectory(name: string): Promise<void> {
  if (directoryRename.target)
    directoryRename.target = await actions.renameDirectory(
      directoryRename.target,
      name,
    );
}

async function moveSelectedDirectory(parent: string): Promise<void> {
  if (directoryMove.target)
    directoryMove.target = await actions.moveDirectory(
      directoryMove.target,
      parent,
    );
}

function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function askDeleteCurrentDirectory(): void {
  const path = browser.directory.value;
  directoryDeletion.ask({ path, name: path.split("/").at(-1) ?? path });
}

function onDeleted(file: FileDto): void {
  if (card.target?.id === file.id) {
    card.open = false;
  }
}
</script>

<template>
  <Card>
    <CardHeader>
      <CardTitle>Файлы</CardTitle>
      <CardDescription>
        Найдено: {{ total }}. Поиск идёт по текущей папке и её подпапкам.
      </CardDescription>
      <CardAction class="flex flex-wrap gap-2">
        <Button
          v-if="browser.directory.value"
          variant="outline"
          class="text-destructive"
          :disabled="browser.loading.value || !!browser.error.value"
          @click="askDeleteCurrentDirectory"
        >
          <Trash2Icon data-icon="inline-start" />
          Удалить этот каталог
        </Button>
        <Button
          variant="outline"
          :disabled="browser.loading.value || !!browser.error.value"
          @click="createOpen = true"
        >
          Создать каталог
        </Button>
        <Button
          :disabled="browser.loading.value || !!browser.error.value"
          @click="uploadOpen = true"
        >
          <UploadIcon data-icon="inline-start" />
          Загрузить файл
        </Button>
      </CardAction>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
      <Button
        v-if="upload.rows.value.length"
        variant="outline"
        class="h-auto justify-start whitespace-normal text-left"
        @click="uploadOpen = true"
      >
        <UploadIcon data-icon="inline-start" />
        <span role="status">Загрузки: {{ upload.summary.value }}</span>
      </Button>
      <div class="flex flex-wrap items-center gap-3">
        <InputGroup class="max-w-sm flex-1">
          <InputGroupAddon>
            <SearchIcon />
          </InputGroupAddon>
          <InputGroupInput
            v-model="browser.searchInput.value"
            placeholder="Поиск по имени файла"
            aria-label="Поиск по имени файла"
          />
        </InputGroup>

        <Select v-model="limitValue">
          <SelectTrigger class="w-36" aria-label="Файлов на странице">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="10"> 10 на странице </SelectItem>
              <SelectItem value="20"> 20 на странице </SelectItem>
              <SelectItem value="50"> 50 на странице </SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <DirectoryBreadcrumbs />

      <Separator />

      <FileTable
        @open="card.ask"
        @download="actions.download"
        @rename="askRename"
        @move="askMove"
        @remove="askDelete"
        @remove-directory="directoryDeletion.ask"
        @rename-directory="directoryRename.ask"
        @move-directory="directoryMove.ask"
      />

      <Pagination
        v-if="totalPages > 1"
        v-slot="{ page }"
        :page="browser.page.value"
        :items-per-page="browser.limit.value"
        :total="total"
        :sibling-count="1"
        show-edges
        @update:page="browser.setPage"
      >
        <PaginationContent v-slot="{ items }">
          <PaginationPrevious />
          <template v-for="(item, index) in items">
            <PaginationItem
              v-if="item.type === 'page'"
              :key="index"
              :value="item.value"
              :is-active="item.value === page"
            >
              {{ item.value }}
            </PaginationItem>
            <PaginationEllipsis
              v-else
              :key="`ellipsis-${index}`"
              :index="index"
            />
          </template>
          <PaginationNext />
        </PaginationContent>
      </Pagination>
    </CardContent>
  </Card>

  <CreateDirectoryDialog v-model:open="createOpen" />
  <DeleteDirectoryDialog
    v-model:open="directoryDeletion.open"
    :directory="directoryDeletion.target"
  />
  <UploadPanel v-model:open="uploadOpen" />

  <FileCardDialog
    v-model:open="card.open"
    :file="card.target"
    @download="actions.download"
    @rename="askRename"
    @move="askMove"
    @remove="askDelete"
  />

  <RenameDialog
    v-model:open="fileRename.open"
    title="Переименование файла"
    :description="`Файл «${fileRename.target?.name ?? ''}»`"
    :initial="fileRename.target?.name ?? ''"
    failure="Не удалось переименовать файл"
    :submit="renameSelected"
  />

  <MoveDialog
    v-model:open="fileMove.open"
    title="Перемещение файла"
    :description="`Выберите каталог для файла «${fileMove.target?.name ?? ''}»`"
    :current="fileMove.target?.directory ?? ''"
    failure="Не удалось переместить файл"
    :submit="moveSelected"
  />

  <RenameDialog
    v-model:open="directoryRename.open"
    title="Переименование каталога"
    :description="`Каталог «${directoryRename.target?.name ?? ''}»`"
    :initial="directoryRename.target?.name ?? ''"
    failure="Не удалось переименовать каталог"
    :submit="renameSelectedDirectory"
  />

  <MoveDialog
    v-model:open="directoryMove.open"
    title="Перемещение каталога"
    :description="`Выберите новый родительский каталог для «${directoryMove.target?.name ?? ''}»`"
    :current="parentOf(directoryMove.target?.path ?? '')"
    :exclude="directoryMove.target?.path"
    failure="Не удалось переместить каталог"
    :submit="moveSelectedDirectory"
  />

  <DeleteFileDialog
    v-model:open="fileDeletion.open"
    :file="fileDeletion.target"
    @deleted="onDeleted"
  />
</template>
