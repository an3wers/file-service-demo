<script setup lang="ts">
import { FolderIcon } from "@lucide/vue"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useFileBrowser } from "@/composables/useFileBrowser"
import { plural } from "@/lib/format"

const browser = useFileBrowser()
</script>

<template>
  <section
    v-if="!browser.error.value && browser.directories.value.length"
    aria-label="Каталоги"
    class="flex flex-col gap-3"
  >
    <h2 class="text-sm font-medium">
      Каталоги
    </h2>
    <ul class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
      <li
        v-for="catalog in browser.directories.value"
        :key="catalog.path"
      >
        <Button
          variant="outline"
          class="w-full justify-start"
          @click="browser.openDirectory(catalog.path)"
        >
          <FolderIcon class="size-4 shrink-0 text-muted-foreground" />
          <span class="truncate">{{ catalog.name }}</span>
          <Badge
            variant="secondary"
            class="ml-auto"
          >
            {{ catalog.fileCount }}
            {{ plural(catalog.fileCount, ["файл", "файла", "файлов"]) }}
          </Badge>
        </Button>
      </li>
    </ul>
  </section>
</template>
