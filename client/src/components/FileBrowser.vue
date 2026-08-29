<script setup lang="ts">
import { computed, ref } from "vue";
import { SearchIcon, UploadIcon } from "@lucide/vue";
import type { FileDto } from "@/types/api";
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
import DeleteFileDialog from "./DeleteFileDialog.vue";
import DirectoryBreadcrumbs from "./DirectoryBreadcrumbs.vue";
import FileCardDialog from "./FileCardDialog.vue";
import FileTable from "./FileTable.vue";
import UploadPanel from "./UploadPanel.vue";
import { useFileActions } from "@/composables/useFileActions";
import { useFileBrowser } from "@/composables/useFileBrowser";

const browser = useFileBrowser();
const actions = useFileActions();

const selectedFile = ref<FileDto | null>(null);
const cardOpen = ref(false);
const fileToDelete = ref<FileDto | null>(null);
const deleteOpen = ref(false);
const uploadOpen = ref(false);

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
  // Карточку закрываем: два модальных слоя подряд дерутся за фокус.
  cardOpen.value = false;
  fileToDelete.value = file;
  deleteOpen.value = true;
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
      <CardAction>
        <Button @click="uploadOpen = true">
          <UploadIcon data-icon="inline-start" />
          Загрузить файл
        </Button>
      </CardAction>
    </CardHeader>

    <CardContent class="flex flex-col gap-4">
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
              <SelectItem value="10">10 на странице</SelectItem>
              <SelectItem value="20">20 на странице</SelectItem>
              <SelectItem value="50">50 на странице</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <DirectoryBreadcrumbs />

      <Separator />

      <FileTable
        @open="openCard"
        @download="actions.download"
        @remove="askDelete"
      />

      <Pagination
        v-if="totalPages > 1"
        v-slot="{ page }"
        :page="browser.page.value"
        :items-per-page="browser.limit.value"
        :total="total"
        :sibling-count="1"
        show-edges
        @update:page="browser.page.value = $event"
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

  <UploadPanel v-model:open="uploadOpen" />

  <FileCardDialog
    v-model:open="cardOpen"
    :file="selectedFile"
    @download="actions.download"
    @remove="askDelete"
  />

  <DeleteFileDialog
    v-model:open="deleteOpen"
    :file="fileToDelete"
    @deleted="onDeleted"
  />
</template>
