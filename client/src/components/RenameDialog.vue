<script setup lang="ts">
import { computed, ref, watch } from "vue";
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

const props = defineProps<{
  open: boolean;
  title: string;
  description: string;
  initial: string;
  failure: string;
  submit: (name: string) => Promise<void>;
}>();
const emit = defineEmits<{ "update:open": [value: boolean] }>();
const name = ref("");
const saving = ref(false);
const error = ref<string | null>(null);
const unchanged = computed(() => name.value.trim() === props.initial.trim());

watch(
  () => props.open,
  (open) => {
    if (open) {
      name.value = props.initial;
      error.value = null;
    }
  },
  { immediate: true },
);

async function send(): Promise<void> {
  if (!name.value.trim() || unchanged.value || saving.value) return;
  saving.value = true;
  error.value = null;
  try {
    await props.submit(name.value);
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
      <form class="flex flex-col gap-4" @submit.prevent="send">
        <DialogHeader>
          <DialogTitle>{{ title }}</DialogTitle>
          <DialogDescription class="break-all">
            {{ description }}
          </DialogDescription>
        </DialogHeader>
        <Field :data-invalid="error ? true : undefined">
          <FieldLabel for="rename-name"> Новое имя </FieldLabel>
          <Input
            id="rename-name"
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
          <Button type="submit" :disabled="!name.trim() || unchanged || saving">
            {{ saving ? "Сохранение…" : "Переименовать" }}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  </Dialog>
</template>
