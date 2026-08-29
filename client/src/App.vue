<script setup lang="ts">
import { HardDriveIcon } from "@lucide/vue"
import { Toaster } from "@/components/ui/sonner"
import FileBrowser from "@/components/FileBrowser.vue"
</script>

<template>
  <div class="min-h-svh bg-background">
    <header class="border-b">
      <div class="mx-auto flex max-w-6xl items-center gap-3 p-6">
        <HardDriveIcon class="size-6 text-muted-foreground" />
        <div>
          <h1 class="text-lg font-semibold">Файловое хранилище</h1>
          <p class="text-muted-foreground text-sm">
            Загрузка, просмотр и скачивание файлов в объектном хранилище
          </p>
        </div>
      </div>
    </header>

    <main class="mx-auto flex max-w-6xl flex-col gap-6 p-6">
      <FileBrowser />
    </main>

    <Toaster rich-colors close-button position="bottom-right" />
  </div>
</template>
