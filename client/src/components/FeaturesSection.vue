<script setup lang="ts">
import type { Component } from "vue";
import {
  CloudUploadIcon,
  DownloadIcon,
  FolderTreeIcon,
  LayersIcon,
} from "@lucide/vue";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Feature = {
  icon: Component;
  title: string;
  description: string;
};

const features: Feature[] = [
  {
    icon: CloudUploadIcon,
    title: "Два режима загрузки",
    description:
      "Через сервер — форма уходит в API вместе с байтами. Напрямую в хранилище — браузер льёт файл по presigned-ссылке, минуя сервер.",
  },
  {
    icon: LayersIcon,
    title: "Большие файлы частями",
    description:
      "От порога размера сервер присылает multipart-план. Части идут параллельно, протухшая ссылка обновляется, прерванная загрузка продолжается с уже залитого.",
  },
  {
    icon: FolderTreeIcon,
    title: "Папки и навигация",
    description:
      "Директория становится префиксом ключа в хранилище: дерево папок, поиск по подпапкам, сортировка по дате, имени и размеру, пагинация.",
  },
  {
    icon: DownloadIcon,
    title: "Скачивание и удаление",
    description:
      "Скачивание идёт по временной ссылке хранилища и возвращает исходное имя файла, включая кириллицу. Удаление убирает и запись, и объект.",
  },
];
</script>

<template>
  <section class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
    <Card
      v-for="feature in features"
      :key="feature.title"
      class="gap-3 py-5"
    >
      <CardHeader class="gap-2 px-5">
        <component
          :is="feature.icon"
          class="size-5 text-muted-foreground"
        />
        <CardTitle class="text-base">
          {{ feature.title }}
        </CardTitle>
        <CardDescription>{{ feature.description }}</CardDescription>
      </CardHeader>
    </Card>
  </section>
</template>
