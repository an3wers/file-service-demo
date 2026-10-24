<script setup lang="ts">
import { ref, watch } from "vue";
import { toast } from "vue-sonner";
import type { DirectoryDto } from "@/types/api";
import { deleteDirectory } from "@/api/directories";
import { isApiError } from "@/api/client";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { errorMessage, requestReference } from "@/lib/errors";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

const props = defineProps<{
  directory: Pick<DirectoryDto, "name" | "path"> | null;
  open: boolean;
}>();

const emit = defineEmits<{ "update:open": [value: boolean] }>();

const browser = useFileBrowser();
const pending = ref(false);
const error = ref<string | null>(null);
const reference = ref<string | null>(null);

watch(
  () => props.open,
  (open) => {
    if (open) {
      error.value = null;
      reference.value = null;
    }
  },
);

function parentOf(path: string): string {
  return path.slice(0, Math.max(0, path.lastIndexOf("/")));
}

function leave(path: string): void {
  const current = browser.directory.value;
  if (current === path || current.startsWith(`${path}/`))
    browser.openDirectory(parentOf(path));
  else browser.refresh();
}

async function confirm(event: Event): Promise<void> {
  event.preventDefault();
  const directory = props.directory;
  if (!directory || pending.value) return;
  pending.value = true;
  error.value = null;
  reference.value = null;
  try {
    await deleteDirectory(directory.path);
    toast.success(`Каталог «${directory.name}» удалён`);
    emit("update:open", false);
    leave(directory.path);
  } catch (cause) {
    if (isApiError(cause) && cause.code === "DIRECTORY_NOT_FOUND") {
      toast.info(`Каталог «${directory.name}» уже был удалён`);
      emit("update:open", false);
      leave(directory.path);
      return;
    }
    error.value = errorMessage(cause, "Не удалось удалить каталог");
    reference.value = requestReference(cause);
  } finally {
    pending.value = false;
  }
}

function updateOpen(open: boolean): void {
  if (!pending.value) emit("update:open", open);
}
</script>

<template>
  <AlertDialog :open="open" @update:open="updateOpen">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>
          Удалить каталог «{{ directory?.name }}»?
        </AlertDialogTitle>
        <AlertDialogDescription>
          Удалить можно только пустой каталог: без подкаталогов, файлов и
          незавершённых загрузок.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div v-if="error" role="alert" class="text-sm text-destructive">
        <p>{{ error }}</p>
        <p v-if="reference" class="opacity-80">{{ reference }}</p>
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending"> Отмена </AlertDialogCancel>
        <Button variant="destructive" :disabled="pending" @click="confirm">
          <Spinner v-if="pending" data-icon="inline-start" />
          {{ pending ? "Удаление…" : "Удалить" }}
        </Button>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
