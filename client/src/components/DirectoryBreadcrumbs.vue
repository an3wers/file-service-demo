<script setup lang="ts">
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { useFileBrowser } from "@/composables/useFileBrowser"

// Пропсов нет: состояние браузера — синглтон на страницу.
const browser = useFileBrowser()
</script>

<template>
  <Breadcrumb>
    <BreadcrumbList>
      <template v-for="(crumb, index) in browser.breadcrumbs.value" :key="crumb.path">
        <BreadcrumbItem>
          <BreadcrumbPage v-if="index === browser.breadcrumbs.value.length - 1">
            {{ crumb.label }}
          </BreadcrumbPage>
          <BreadcrumbLink
            v-else
            as="button"
            type="button"
            class="cursor-pointer"
            @click="browser.goTo(crumb.path)"
          >
            {{ crumb.label }}
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator v-if="index < browser.breadcrumbs.value.length - 1" />
      </template>
    </BreadcrumbList>
  </Breadcrumb>
</template>
