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
import { useRouter } from "vue-router";
import { confirmPasswordReset, requestPasswordReset } from "@/api/auth";
import { isApiError } from "@/api/client";
import { readSharedAuth } from "@/api/sharedAuth";
import { useAuth } from "@/composables/useAuth";
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

const TOKEN_KEY = "file-service-password-reset-token";
const FORM_KEY = "file-service-password-reset-form";

const auth = useAuth();
const token = ref("");
const state = ref({ email: "", retryAt: 0, confirmRetryAt: 0, message: "" });
try {
  token.value = sessionStorage.getItem(TOKEN_KEY) ?? "";
  const saved = JSON.parse(sessionStorage.getItem(FORM_KEY) ?? "null");
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

const password = ref("");
const passwordConfirmation = ref("");
const now = ref(Date.now());
const pending = ref<"confirm" | "request" | null>(null);
const failure = ref("");
const fieldErrors = ref<Record<string, string>>({});
const feedback = useTemplateRef<HTMLDivElement>("feedback");
const inputs = {
  password: useTemplateRef<{ $el: HTMLInputElement }>("passwordInput"),
  passwordConfirmation: useTemplateRef<{ $el: HTMLInputElement }>(
    "confirmationInput",
  ),
  email: useTemplateRef<{ $el: HTMLInputElement }>("emailInput"),
};
let controller = new AbortController();
const removeNavigationListener = useRouter().afterEach((to) => {
  if (to.name !== "password-reset") return;
  let nextToken: string;
  try {
    nextToken = sessionStorage.getItem(TOKEN_KEY) ?? "";
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
  password.value = "";
  passwordConfirmation.value = "";
  pending.value = null;
  failure.value = "";
  fieldErrors.value = {};
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
      sessionStorage.setItem(FORM_KEY, JSON.stringify(state.value));
    } catch {
      return;
    }
  },
  { deep: true },
);

function forgetToken() {
  token.value = "";
  password.value = "";
  passwordConfirmation.value = "";
  try {
    sessionStorage.removeItem(TOKEN_KEY);
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
  fieldErrors.value = {};
  state.value.message = "";
  const requestController = controller;
  try {
    if (action === "confirm") {
      const response = await confirmPasswordReset(
        {
          token: token.value,
          password: password.value,
          passwordConfirmation: passwordConfirmation.value,
        },
        requestController.signal,
      );
      if (requestController.signal.aborted) return;
      state.value.message = response.message;
      forgetToken();
      if (auth.signedIn.value || readSharedAuth().signedIn) await auth.renew();
    } else {
      const response = await requestPasswordReset(
        { email: state.value.email },
        requestController.signal,
      );
      if (requestController.signal.aborted) return;
      state.value.message = response.message;
      state.value.retryAt = Date.now() + response.retryAfterSeconds * 1000;
    }
  } catch (error) {
    if (requestController.signal.aborted) return;
    failure.value = errorMessage(
      error,
      "Не удалось выполнить запрос. Попробуйте ещё раз",
    );
    if (isApiError(error)) {
      if (error.code === "PASSWORD_RESET_LINK_INVALID") forgetToken();
      const details = error.details as
        | { retryAfterSeconds?: number; fieldErrors?: Record<string, string[]> }
        | undefined;
      fieldErrors.value = Object.fromEntries(
        Object.entries(details?.fieldErrors ?? {}).map(([field, messages]) => [
          field,
          messages.join(". "),
        ]),
      );
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
        const invalid = (
          ["password", "passwordConfirmation", "email"] as const
        ).find((field) => fieldErrors.value[field]);
        if (invalid) inputs[invalid].value?.$el.focus();
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
    sessionStorage.removeItem(FORM_KEY);
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
          <CardTitle class="text-lg">Восстановление пароля</CardTitle>
          <CardDescription
            >Задайте новый пароль по ссылке из письма</CardDescription
          >
        </CardHeader>
        <CardContent class="space-y-6" :aria-busy="!!pending">
          <form
            v-if="token"
            data-confirm
            novalidate
            @submit.prevent="submit('confirm')"
          >
            <FieldGroup>
              <Field>
                <FieldLabel for="reset-password">Новый пароль</FieldLabel>
                <Input
                  id="reset-password"
                  ref="passwordInput"
                  v-model="password"
                  name="password"
                  type="password"
                  autocomplete="new-password"
                  :disabled="!!pending"
                  :aria-invalid="!!fieldErrors.password"
                  aria-describedby="reset-password-error"
                />
                <FieldError id="reset-password-error">{{
                  fieldErrors.password
                }}</FieldError>
              </Field>
              <Field>
                <FieldLabel for="reset-password-confirmation"
                  >Повторите пароль</FieldLabel
                >
                <Input
                  id="reset-password-confirmation"
                  ref="confirmationInput"
                  v-model="passwordConfirmation"
                  name="passwordConfirmation"
                  type="password"
                  autocomplete="new-password"
                  :disabled="!!pending"
                  :aria-invalid="!!fieldErrors.passwordConfirmation"
                  aria-describedby="reset-password-confirmation-error"
                />
                <FieldError id="reset-password-confirmation-error">{{
                  fieldErrors.passwordConfirmation
                }}</FieldError>
              </Field>
              <Button type="submit" :disabled="!!pending || confirmRetry > 0">
                <Spinner v-if="pending === 'confirm'" />
                {{ pending === "confirm" ? "Сохраняем…" : "Сохранить пароль" }}
              </Button>
              <p v-if="confirmRetry" role="status">
                Повторить можно через {{ confirmRetry }} с
              </p>
            </FieldGroup>
          </form>
          <p v-else-if="!state.message && !failure">
            Откройте ссылку из письма или запросите новое письмо восстановления.
          </p>
          <div
            v-if="state.message || failure"
            ref="feedback"
            tabindex="-1"
            :role="failure ? 'alert' : 'status'"
          >
            {{ failure || state.message }}
          </div>
          <form data-request novalidate @submit.prevent="submit('request')">
            <FieldGroup>
              <Field>
                <FieldLabel for="reset-email">Email</FieldLabel>
                <Input
                  id="reset-email"
                  ref="emailInput"
                  v-model="state.email"
                  name="email"
                  type="email"
                  autocomplete="email"
                  :disabled="!!pending"
                  :aria-invalid="!!fieldErrors.email"
                  aria-describedby="reset-email-error"
                />
                <FieldError id="reset-email-error">{{
                  fieldErrors.email
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
                    : "Отправить письмо восстановления"
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
