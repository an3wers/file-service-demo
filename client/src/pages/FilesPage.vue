<script setup lang="ts">
import { ref } from "vue"
import { HardDriveIcon, LogOutIcon } from "@lucide/vue"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import FeaturesSection from "@/components/FeaturesSection.vue"
import FileBrowser from "@/components/FileBrowser.vue"
import { useAuth } from "@/composables/useAuth"
import { useUpload } from "@/composables/useUpload"
import { cn } from "@/lib/utils"

const auth = useAuth()
const upload = useUpload()
const confirmOpen = ref(false)
const loggingOut = ref(false)

async function logout(): Promise<void> {
  loggingOut.value = true

  try {
    await auth.logout()
  } finally {
    loggingOut.value = false
  }
}

function requestLogout(): void {
  if (upload.uploading.value) {
    confirmOpen.value = true
    return
  }

  void logout()
}

function confirmLogout(): void {
  confirmOpen.value = false
  void logout()
}
</script>

<template>
  <div class="min-h-svh bg-background">
    <header class="border-b">
      <div class="mx-auto flex max-w-6xl items-center gap-3 p-6">
        <HardDriveIcon class="size-6 text-muted-foreground" />
        <div class="flex-1">
          <h1 class="text-lg font-semibold">
            Файловое хранилище
          </h1>
          <p class="text-muted-foreground text-sm">
            Загрузка, просмотр и скачивание файлов в объектном хранилище
          </p>
        </div>
        <span class="text-muted-foreground text-sm">{{ auth.user.value?.login }}</span>
        <Button
          variant="outline"
          :disabled="loggingOut"
          @click="requestLogout"
        >
          <Spinner
            v-if="loggingOut"
            data-icon="inline-start"
          />
          <LogOutIcon
            v-else
            data-icon="inline-start"
          />
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
            Идёт загрузка файла — она прервётся
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
