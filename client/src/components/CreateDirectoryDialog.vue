<script setup lang="ts">
import { ref, watch } from "vue";
import { createDirectory } from "@/api/directories";
import { useFileBrowser } from "@/composables/useFileBrowser";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const browser = useFileBrowser();
const name = ref("");
const saving = ref(false);
const error = ref<string | null>(null);
const parent = ref("");

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = "";
      error.value = null;
      parent.value = browser.directory.value;
    }
  },
);

async function submit(): Promise<void> {
  if (!name.value.trim() || saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await createDirectory(parent.value, name.value);
    browser.refresh();
    emit("update:open", false);
  } catch (cause) {
    error.value = errorMessage(cause, "Не удалось создать каталог");
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
      <form class="flex flex-col gap-4" @submit.prevent="submit">
        <DialogHeader>
          <DialogTitle>Создание каталога</DialogTitle>
          <DialogDescription>
            Родительский каталог: {{ parent || "Корень" }}. Введите одно имя.
          </DialogDescription>
        </DialogHeader>
        <Field :data-invalid="error ? true : undefined">
          <FieldLabel for="directory-name"> Имя каталога </FieldLabel>
          <Input
            id="directory-name"
            v-model="name"
            :disabled="saving"
            :aria-invalid="error ? true : undefined"
          />
          <FieldError v-if="error" role="alert">
            {{ error }}
          </FieldError>
        </Field>
        <DialogFooter>
          <DialogClose as-child>
            <Button type="button" variant="outline" :disabled="saving">
              Отмена
            </Button>
          </DialogClose>
          <Button type="submit" :disabled="!name.trim() || saving">
            {{ saving ? "Создание…" : "Создать" }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
