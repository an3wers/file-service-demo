<script setup lang="ts">
import { ref } from "vue"
import type { FileDto } from "@/types/api"
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
import { buttonVariants } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { cn } from "@/lib/utils"
import { useFileActions } from "@/composables/useFileActions"

const props = defineProps<{ file: FileDto | null; open: boolean }>()

const emit = defineEmits<{
  "update:open": [value: boolean]
  deleted: [file: FileDto]
}>()

const actions = useFileActions()
const pending = ref(false)

async function confirm(event: Event): Promise<void> {
  // Диалог закрываем сами — только после того, как запрос действительно прошёл.
  event.preventDefault()

  const file = props.file

  if (!file || pending.value) {
    return
  }

  pending.value = true

  try {
    await actions.remove(file)
    emit("deleted", file)
    emit("update:open", false)
  } catch {
    // Текст ошибки уже показан тостом внутри `remove`.
  } finally {
    pending.value = false
  }
}
</script>

<template>
  <AlertDialog :open="open" @update:open="emit('update:open', $event)">
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Удалить файл?</AlertDialogTitle>
        <AlertDialogDescription>
          Файл «{{ file?.name }}» будет удалён безвозвратно — отменить действие нельзя.
        </AlertDialogDescription>
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel :disabled="pending">Отмена</AlertDialogCancel>
        <AlertDialogAction
          :class="cn(buttonVariants({ variant: 'destructive' }))"
          :disabled="pending"
          @click="confirm"
        >
          <Spinner v-if="pending" data-icon="inline-start" />
          Удалить
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>
</template>
