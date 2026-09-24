<script setup lang="ts">
import { computed } from "vue";
import { RouterView, useRoute, useRouter } from "vue-router";
import { RotateCwIcon, ServerCrashIcon } from "@lucide/vue";
import { Button } from "@/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Toaster } from "@/components/ui/sonner";
import { Spinner } from "@/components/ui/spinner";
import { useAuth } from "@/composables/useAuth";
import { errorMessage } from "@/lib/errors";

const auth = useAuth();
const route = useRoute();
const router = useRouter();

const allowed = computed(
  () => !route.meta.requiresAuth || auth.signedIn.value,
);

function retry(): void {
  void router.replace({ path: route.fullPath, force: true });
}
</script>

<template>
  <div
    v-if="auth.status.value === 'booting'"
    class="flex min-h-svh items-center justify-center bg-background"
  >
    <Spinner class="size-8 text-muted-foreground" />
  </div>

  <div
    v-else-if="auth.status.value === 'failed'"
    class="flex min-h-svh items-center justify-center bg-background p-6"
  >
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <ServerCrashIcon />
        </EmptyMedia>
        <EmptyTitle>Не удалось открыть приложение</EmptyTitle>
        <EmptyDescription>
          {{ errorMessage(auth.bootError.value) }}
        </EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button @click="retry">
          <RotateCwIcon data-icon="inline-start" />
          Повторить
        </Button>
      </EmptyContent>
    </Empty>
  </div>

  <RouterView v-else-if="allowed" />

  <Toaster
    rich-colors
    close-button
    position="bottom-right"
  />
</template>
