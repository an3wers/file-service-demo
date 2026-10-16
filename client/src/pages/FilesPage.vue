<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { HardDriveIcon, LogOutIcon } from "@lucide/vue";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import FeaturesSection from "@/components/FeaturesSection.vue";
import FileBrowser from "@/components/FileBrowser.vue";
import ThemeSelect from "@/components/ThemeSelect.vue";
import { useAuth } from "@/composables/useAuth";
import { useUpload } from "@/composables/useUpload";
import { cn } from "@/lib/utils";

const auth = useAuth();
const upload = useUpload();
const confirmOpen = ref(false);
const loggingOut = ref(false);

function warnBeforeLeaving(event: BeforeUnloadEvent): void {
  event.preventDefault();
  event.returnValue = true;
}

watch(
  () => upload.uploading.value || upload.hasSelected.value,
  (unfinished) => {
    if (unfinished) window.addEventListener("beforeunload", warnBeforeLeaving);
    else window.removeEventListener("beforeunload", warnBeforeLeaving);
  },
  { immediate: true, flush: "sync" },
);
onUnmounted(() =>
  window.removeEventListener("beforeunload", warnBeforeLeaving),
);

async function logout(): Promise<void> {
  loggingOut.value = true;

  try {
    await auth.logout();
  } finally {
    loggingOut.value = false;
  }
}

function requestLogout(): void {
  if (upload.uploading.value || upload.hasSelected.value) {
    confirmOpen.value = true;
    return;
  }

  void logout();
}

function confirmLogout(): void {
  confirmOpen.value = false;
  void logout();
}
</script>

<template>
  <div class="min-h-svh bg-background">
    <header class="border-b">
      <div class="mx-auto flex max-w-6xl flex-wrap items-center gap-3 p-6">
        <HardDriveIcon class="size-6 text-muted-foreground" />
        <div class="min-w-0 flex-1 basis-48">
          <h1 class="text-lg font-semibold">Файловое хранилище</h1>
          <p class="text-muted-foreground text-sm">
            Загрузка, просмотр и скачивание файлов в объектном хранилище
          </p>
        </div>
        <ThemeSelect />
        <span class="max-w-full break-all text-muted-foreground text-sm">{{
          auth.user.value?.login
        }}</span>
        <Button variant="outline" :disabled="loggingOut" @click="requestLogout">
          <Spinner v-if="loggingOut" data-icon="inline-start" />
          <LogOutIcon v-else data-icon="inline-start" />
          Выйти
        </Button>
      </div>
    </header>

    <main class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <FeaturesSection />
      <FileBrowser />
    </main>

    <AlertDialog v-model:open="confirmOpen">
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Выйти?</AlertDialogTitle>
          <AlertDialogDescription>
            Ожидающие загрузки будут остановлены, выбранные файлы и история
            очищены. Уже принятые сервером обработка и подтверждение могут
            завершиться после выхода.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Остаться</AlertDialogCancel>
          <AlertDialogAction
            :class="cn(buttonVariants({ variant: 'destructive' }))"
            @click="confirmLogout"
          >
            Выйти
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </div>
</template>
