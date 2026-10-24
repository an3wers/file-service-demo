<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FolderIcon } from "@lucide/vue";
import type { DirectoryDto } from "@/types/api";
import { listDirectories } from "@/api/directories";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const props = defineProps<{
  open: boolean;
  title: string;
  description: string;
  current: string;
  failure: string;
  submit: (directory: string) => Promise<void>;
}>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const target = ref("");
const children = ref<DirectoryDto[]>([]);
const loading = ref(false);
const saving = ref(false);
const error = ref<string | null>(null);
let request = 0;

const crumbs = computed(() => {
  const segments = target.value.split("/").filter(Boolean);
  return [
    { label: "Корень", path: "" },
    ...segments.map((label, index) => ({
      label,
      path: segments.slice(0, index + 1).join("/"),
    })),
  ];
});

async function browse(path: string): Promise<void> {
  const id = ++request;
  target.value = path;
  loading.value = true;
  error.value = null;
  try {
    const { items } = await listDirectories(path);
    if (id === request) children.value = items;
  } catch (cause) {
    if (id !== request) return;
    children.value = [];
    error.value = errorMessage(cause, "Не удалось загрузить каталоги");
  } finally {
    if (id === request) loading.value = false;
  }
}

watch(
  () => props.open,
  (open) => {
    if (open) void browse("");
  },
  { immediate: true },
);

async function send(): Promise<void> {
  if (saving.value || loading.value || target.value === props.current) return;
  saving.value = true;
  error.value = null;
  try {
    await props.submit(target.value);
    emit("update:open", false);
  } catch (cause) {
    error.value = errorMessage(cause, props.failure);
  } finally {
    saving.value = false;
  }
}

function updateOpen(open: boolean): void {
  if (!saving.value) emit("update:open", open);
}
</script>

<template>
  <Dialog :open="open" @update:open="updateOpen">
    <DialogContent :show-close-button="!saving">
      <DialogHeader>
        <DialogTitle>{{ title }}</DialogTitle>
        <DialogDescription class="break-all">
          {{ description }}
        </DialogDescription>
      </DialogHeader>
      <Breadcrumb>
        <BreadcrumbList>
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <BreadcrumbSeparator v-if="index > 0" />
            <BreadcrumbItem>
              <Button
                variant="link"
                size="sm"
                class="h-auto p-0"
                :disabled="saving"
                @click="browse(crumb.path)"
              >
                {{ crumb.label }}
              </Button>
            </BreadcrumbItem>
          </template>
        </BreadcrumbList>
      </Breadcrumb>
      <div class="flex max-h-64 flex-col gap-1 overflow-y-auto">
        <template v-if="loading">
          <Skeleton v-for="row in 3" :key="row" class="h-8 w-full" />
        </template>
        <template v-else>
          <Button
            v-for="child in children"
            :key="child.path"
            variant="ghost"
            class="justify-start"
            :disabled="saving"
            @click="browse(child.path)"
          >
            <FolderIcon data-icon="inline-start" aria-hidden="true" />
            <span class="truncate">{{ child.name }}</span>
          </Button>
          <p v-if="!children.length" class="text-muted-foreground text-sm">
            Вложенных каталогов нет
          </p>
        </template>
      </div>
      <p class="break-all text-sm">Текущий выбор: {{ target || "Корень" }}</p>
      <p v-if="error" role="alert" class="text-destructive text-sm">
        {{ error }}
      </p>
      <DialogFooter>
        <DialogClose as-child>
          <Button type="button" variant="outline" :disabled="saving">
            Отмена
          </Button>
        </DialogClose>
        <Button
          :disabled="saving || loading || target === current"
          @click="send"
        >
          {{ saving ? "Перемещение…" : "Переместить сюда" }}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
</template>
