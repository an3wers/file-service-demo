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
import { useFileActions } from "@/composables/useFileActions";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { useFileBrowserRoute } from "@/composables/useFileBrowserRoute";
import { useUpload } from "@/composables/useUpload";

const browser = useFileBrowser();
const actions = useFileActions();
const upload = useUpload();

useFileBrowserRoute();

const selectedFile = ref<FileDto | null>(null);
const cardOpen = ref(false);
const fileToDelete = ref<FileDto | null>(null);
const deleteOpen = ref(false);
const fileToRename = ref<FileDto | null>(null);
const renameOpen = ref(false);
const fileToMove = ref<FileDto | null>(null);
const moveOpen = ref(false);
const uploadOpen = ref(false);
const createOpen = ref(false);
const directoryToDelete = ref<Pick<DirectoryDto, "name" | "path"> | null>(null);
const deleteDirectoryOpen = ref(false);

const limitValue = computed({
  get: () => String(browser.limit.value),
  set: (value: string) => browser.setLimit(Number(value)),
});

const totalPages = computed(() => browser.pagination.value?.totalPages ?? 1);
const total = computed(() => browser.pagination.value?.total ?? 0);

function openCard(file: FileDto): void {
  selectedFile.value = file;
  cardOpen.value = true;
}

function askDelete(file: FileDto): void {
  cardOpen.value = false;
  fileToDelete.value = file;
  deleteOpen.value = true;
}

function askRename(file: FileDto): void {
  cardOpen.value = false;
  fileToRename.value = file;
  renameOpen.value = true;
}

function askMove(file: FileDto): void {
  cardOpen.value = false;
  fileToMove.value = file;
  moveOpen.value = true;
}

async function renameSelected(name: string): Promise<void> {
  if (fileToRename.value)
    fileToRename.value = await actions.rename(fileToRename.value, name);
}

async function moveSelected(directory: string): Promise<void> {
  if (fileToMove.value)
    fileToMove.value = await actions.move(fileToMove.value, directory);
}

function askDeleteDirectory(directory: Pick<DirectoryDto, "name" | "path">) {
  directoryToDelete.value = directory;
  deleteDirectoryOpen.value = true;
}

function askDeleteCurrentDirectory(): void {
  const path = browser.directory.value;
  askDeleteDirectory({ path, name: path.split("/").at(-1) ?? path });
}

function onDeleted(file: FileDto): void {
  if (selectedFile.value?.id === file.id) {
    cardOpen.value = false;
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
        @open="openCard"
        @download="actions.download"
        @rename="askRename"
        @move="askMove"
        @remove="askDelete"
        @remove-directory="askDeleteDirectory"
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
    v-model:open="deleteDirectoryOpen"
    :directory="directoryToDelete"
  />
  <UploadPanel v-model:open="uploadOpen" />

  <FileCardDialog
    v-model:open="cardOpen"
    :file="selectedFile"
    @download="actions.download"
    @rename="askRename"
    @move="askMove"
    @remove="askDelete"
  />

  <RenameDialog
    v-model:open="renameOpen"
    title="Переименование файла"
    :description="`Файл «${fileToRename?.name ?? ''}»`"
    :initial="fileToRename?.name ?? ''"
    failure="Не удалось переименовать файл"
    :submit="renameSelected"
  />

  <MoveDialog
    v-model:open="moveOpen"
    title="Перемещение файла"
    :description="`Выберите каталог для файла «${fileToMove?.name ?? ''}»`"
    :current="fileToMove?.directory ?? ''"
    failure="Не удалось переместить файл"
    :submit="moveSelected"
  />

  <DeleteFileDialog
    v-model:open="deleteOpen"
    :file="fileToDelete"
    @deleted="onDeleted"
  />
</template>
