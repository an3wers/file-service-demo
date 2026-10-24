<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { HardDriveIcon } from "@lucide/vue";
import { confirmActivation, requestActivation } from "@/api/auth";
import { isApiError } from "@/api/client";
import { errorMessage } from "@/lib/errors";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import ThemeSelect from "@/components/ThemeSelect.vue";
import { useRouter } from "vue-router";

const token = ref("");
const state = ref({ email: "", retryAt: 0, confirmRetryAt: 0, message: "" });
try {
  token.value = sessionStorage.getItem("file-service-activation-token") ?? "";
  const saved = JSON.parse(
    sessionStorage.getItem("file-service-activation-form") ?? "null",
  );
  if (
    saved &&
    typeof saved.email === "string" &&
    Number.isFinite(saved.retryAt) &&
    Number.isFinite(saved.confirmRetryAt) &&
    typeof saved.message === "string"
  )
    state.value = {
      email: saved.email,
      retryAt: saved.retryAt,
      confirmRetryAt: saved.confirmRetryAt,
      message: saved.message,
    };
} catch {
  token.value = "";
}

const now = ref(Date.now());
const pending = ref<"confirm" | "request" | null>(null);
const failure = ref("");
const emailError = ref("");
const feedback = useTemplateRef<HTMLDivElement>("feedback");
const emailInput = useTemplateRef<{ $el: HTMLInputElement }>("emailInput");
let controller = new AbortController();
const removeNavigationListener = useRouter().afterEach((to) => {
  if (to.name !== "activation") return;
  let nextToken: string;
  try {
    nextToken = sessionStorage.getItem("file-service-activation-token") ?? "";
  } catch {
    return;
  }
  if (nextToken === token.value) return;
  resetLink(nextToken);
});

function resetLink(nextToken: string) {
  controller.abort();
  controller = new AbortController();
  token.value = nextToken;
  state.value = { email: "", retryAt: 0, confirmRetryAt: 0, message: "" };
  pending.value = null;
  failure.value = "";
  emailError.value = "";
}
const retry = computed(() =>
  Math.max(0, Math.ceil((state.value.retryAt - now.value) / 1000)),
);
const confirmRetry = computed(() =>
  Math.max(0, Math.ceil((state.value.confirmRetryAt - now.value) / 1000)),
);
const timer = setInterval(() => {
  now.value = Date.now();
}, 1000);

watch(
  state,
  () => {
    try {
      sessionStorage.setItem(
        "file-service-activation-form",
        JSON.stringify(state.value),
      );
    } catch {
      return;
    }
  },
  { deep: true },
);

function forgetToken() {
  token.value = "";
  try {
    sessionStorage.removeItem("file-service-activation-token");
  } catch {
    return;
  }
}

function restored(event: PageTransitionEvent) {
  if (!event.persisted) return;
  forgetToken();
  resetLink("");
}
window.addEventListener("pageshow", restored);

async function submit(action: "confirm" | "request") {
  if (
    pending.value ||
    (action === "confirm"
      ? !token.value || confirmRetry.value > 0
      : !state.value.email.trim() || retry.value > 0)
  )
    return;
  pending.value = action;
  failure.value = "";
  emailError.value = "";
  state.value.message = "";
  const requestController = controller;
  try {
    const response =
      action === "confirm"
        ? await confirmActivation(token.value, requestController.signal)
        : await requestActivation(
            { email: state.value.email },
            requestController.signal,
          );
    if (requestController.signal.aborted) return;
    state.value.message = response.message;
    if (action === "confirm") forgetToken();
    else if ("retryAfterSeconds" in response)
      state.value.retryAt = Date.now() + response.retryAfterSeconds * 1000;
  } catch (error) {
    if (requestController.signal.aborted) return;
    failure.value = errorMessage(
      error,
      "Не удалось выполнить запрос. Попробуйте ещё раз",
    );
    if (isApiError(error)) {
      if (error.code === "ACTIVATION_LINK_INVALID") forgetToken();
      const details = error.details as
        | { retryAfterSeconds?: number; fieldErrors?: Record<string, string[]> }
        | undefined;
      emailError.value = details?.fieldErrors?.email?.join(". ") ?? "";
      if (error.status === 429 && details?.retryAfterSeconds) {
        const until = Date.now() + details.retryAfterSeconds * 1000;
        if (action === "confirm") state.value.confirmRetryAt = until;
        else state.value.retryAt = until;
      }
    }
  } finally {
    if (!requestController.signal.aborted) {
      pending.value = null;
      now.value = Date.now();
      await nextTick();
      if (!requestController.signal.aborted) {
        if (emailError.value) emailInput.value?.$el.focus();
        else feedback.value?.focus();
      }
    }
  }
}

onBeforeUnmount(() => {
  controller.abort();
  removeNavigationListener();
  clearInterval(timer);
  window.removeEventListener("pageshow", restored);
  forgetToken();
  try {
    sessionStorage.removeItem("file-service-activation-form");
  } catch {
    return;
  }
});
</script>

<template>
  <div class="flex min-h-svh flex-col bg-background">
    <header class="flex justify-end p-6 pb-0"><ThemeSelect /></header>
    <main class="flex flex-1 items-center justify-center p-6">
      <Card class="w-full max-w-sm">
        <CardHeader class="items-center text-center">
          <HardDriveIcon class="mx-auto size-8 text-muted-foreground" />
          <CardTitle class="text-lg">Подтверждение email</CardTitle>
          <CardDescription
            >Подтвердите адрес, чтобы затем войти в хранилище</CardDescription
          >
        </CardHeader>
        <CardContent class="space-y-6" :aria-busy="!!pending">
          <div v-if="token" class="space-y-3">
            <p>Нажмите кнопку, чтобы подтвердить email из письма.</p>
            <Button
              type="button"
              data-confirm
              :disabled="!!pending || confirmRetry > 0"
              @click="submit('confirm')"
            >
              <Spinner v-if="pending === 'confirm'" />
              {{
                pending === "confirm" ? "Подтверждаем…" : "Подтвердить email"
              }}
            </Button>
            <p v-if="confirmRetry" role="status">
              Подтвердить можно через {{ confirmRetry }} с
            </p>
          </div>
          <p v-else-if="!state.message && !failure">
            Откройте ссылку из письма или запросите новое письмо активации.
          </p>
          <div
            v-if="state.message || failure"
            ref="feedback"
            tabindex="-1"
            :role="failure ? 'alert' : 'status'"
          >
            {{ failure || state.message }}
          </div>
          <form novalidate @submit.prevent="submit('request')">
            <FieldGroup>
              <Field>
                <FieldLabel for="activation-email">Email</FieldLabel>
                <Input
                  id="activation-email"
                  ref="emailInput"
                  v-model="state.email"
                  name="email"
                  type="email"
                  autocomplete="email"
                  :disabled="!!pending"
                  :aria-invalid="!!emailError"
                  aria-describedby="activation-email-error"
                />
                <FieldError id="activation-email-error">{{
                  emailError
                }}</FieldError>
              </Field>
              <Button
                type="submit"
                :disabled="!!pending || !state.email.trim() || retry > 0"
              >
                <Spinner v-if="pending === 'request'" />
                {{
                  pending === "request"
                    ? "Обрабатываем запрос…"
                    : "Отправить письмо активации повторно"
                }}
              </Button>
              <p v-if="retry" role="status">
                Повторить можно через {{ retry }} с
              </p>
            </FieldGroup>
          </form>
          <a href="/login" class="block text-sm underline" @click="forgetToken"
            >Перейти ко входу</a
          >
        </CardContent>
      </Card>
    </main>
  </div>
</template>
