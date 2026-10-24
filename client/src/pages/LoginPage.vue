<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LoginAttempt } from "@/api/generated";
import { login as requestLogin, resendLoginCode } from "@/api/auth";
import { serverNow } from "@/api/client";
import { readSharedAuth } from "@/api/sharedAuth";
import { safeReturnTo } from "@/lib/returnTo";
import { EyeIcon, EyeOffIcon, HardDriveIcon } from "@lucide/vue";
import { isApiError } from "@/api/client";
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
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import ThemeSelect from "@/components/ThemeSelect.vue";
import { useAuth } from "@/composables/useAuth";
import { errorMessage } from "@/lib/errors";

const auth = useAuth();
const router = useRouter();

const email = ref("");
const code = ref("");
const attempt = ref<LoginAttempt | null>(null);
const storageKey = "file-service-login-attempt";
let clockOffset = 0;
let generation = readSharedAuth().generation;
const remainingAttempts = ref<number | null>(null);
try {
  const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
  if (
    saved &&
    saved.generation === generation &&
    typeof saved.attempt?.attemptToken === "string" &&
    Number.isFinite(saved.clockOffset) &&
    [
      saved.attempt.attemptExpiresAt,
      saved.attempt.codeExpiresAt,
      saved.attempt.resendAvailableAt,
    ].every(
      (value) =>
        typeof value === "string" && Number.isFinite(Date.parse(value)),
    ) &&
    ["accepted", "unconfirmed"].includes(saved.attempt.deliveryStatus)
  ) {
    attempt.value = saved.attempt;
    clockOffset = saved.clockOffset;
    if (Number.isInteger(saved.remainingAttempts))
      remainingAttempts.value = saved.remainingAttempts;
  }
} catch {
  attempt.value = null;
}
const now = ref(Date.now() + clockOffset);
const codeRemaining = computed(() =>
  Math.max(
    0,
    Math.ceil(
      (Date.parse(attempt.value?.codeExpiresAt ?? "") - now.value) / 1000,
    ),
  ),
);
const attemptRemaining = computed(() =>
  Math.max(
    0,
    Math.ceil(
      (Date.parse(attempt.value?.attemptExpiresAt ?? "") - now.value) / 1000,
    ),
  ),
);
const resendRemaining = computed(() =>
  Math.max(
    0,
    Math.ceil(
      (Date.parse(attempt.value?.resendAvailableAt ?? "") - now.value) / 1000,
    ),
  ),
);
const retryAt = ref(0);
const retryRemaining = computed(() =>
  Math.max(0, Math.ceil((retryAt.value - now.value) / 1000)),
);
const codeInput = useTemplateRef<{ $el: HTMLInputElement }>("codeInput");
const feedback = useTemplateRef<HTMLDivElement>("feedback");
const route = useRoute();
const controller = new AbortController();
const timer = setInterval(() => {
  now.value = Date.now() + clockOffset;
}, 1000);
onBeforeUnmount(() => {
  controller.abort();
  clearInterval(timer);
  password.value = "";
});
function forgetAttempt() {
  attempt.value = null;
  code.value = "";
  remainingAttempts.value = null;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    return;
  }
}
function saveAttempt(): boolean {
  try {
    sessionStorage.setItem(
      storageKey,
      JSON.stringify({
        attempt: attempt.value,
        clockOffset,
        generation,
        remainingAttempts: remainingAttempts.value,
      }),
    );
    return true;
  } catch {
    return false;
  }
}
function syncClock() {
  clockOffset = serverNow() - Date.now();
  now.value = Date.now() + clockOffset;
}
async function resend(): Promise<void> {
  if (!attempt.value || pending.value || resendRemaining.value > 0) return;
  pending.value = true;
  failure.value = null;
  try {
    const response = await resendLoginCode(
      attempt.value.attemptToken,
      controller.signal,
    );
    if (controller.signal.aborted || !attempt.value) return;
    syncClock();
    attempt.value = { ...attempt.value, ...response };
    code.value = "";
    saveAttempt();
  } catch (error) {
    if (controller.signal.aborted) return;
    failure.value = errorMessage(error, "Не удалось отправить код");
    if (isApiError(error)) {
      const details = error.details as
        { retryAfterSeconds?: number } | undefined;
      if (error.code === "LOGIN_ATTEMPT_INVALID") forgetAttempt();
      else if (
        error.status === 429 &&
        details?.retryAfterSeconds &&
        attempt.value
      ) {
        syncClock();
        attempt.value = {
          ...attempt.value,
          resendAvailableAt: new Date(
            now.value + details.retryAfterSeconds * 1000,
          ).toISOString(),
        };
        saveAttempt();
      }
    }
  } finally {
    if (!controller.signal.aborted) {
      pending.value = false;
      await nextTick();
      if (attempt.value && !failure.value) codeInput.value?.$el.focus();
      else feedback.value?.focus();
    }
  }
}
function restart() {
  forgetAttempt();
  failure.value = null;
}

const password = ref("");
const passwordVisible = ref(false);
const pending = ref(false);
const failure = ref<string | null>(null);
const notVerified = ref(false);
const passwordInput = useTemplateRef<{ $el: HTMLInputElement }>(
  "passwordInput",
);

const canSubmit = computed(
  () =>
    !pending.value &&
    retryRemaining.value === 0 &&
    (attempt.value
      ? /^[0-9]{6}$/.test(code.value) &&
        codeRemaining.value > 0 &&
        attemptRemaining.value > 0
      : email.value.trim() !== "" && password.value !== ""),
);

async function submit(): Promise<void> {
  if (!canSubmit.value) return;
  pending.value = true;
  failure.value = null;
  notVerified.value = false;
  try {
    if (attempt.value) {
      await auth.verifyLogin(
        attempt.value.attemptToken,
        code.value,
        generation,
      );
      if (controller.signal.aborted) return;
      forgetAttempt();
      await router.push(safeReturnTo(route.query.returnTo));
    } else {
      const started = readSharedAuth().generation;
      const response = await requestLogin(
        email.value,
        password.value,
        controller.signal,
      );
      if (controller.signal.aborted) return;
      password.value = "";
      passwordVisible.value = false;
      attempt.value = response;
      generation = started;
      syncClock();
      if (!saveAttempt())
        failure.value =
          "Не удалось сохранить попытку. После обновления страницы потребуется новый вход";
    }
  } catch (error) {
    if (controller.signal.aborted) return;
    failure.value = errorMessage(error, "Не удалось войти");
    password.value = "";
    if (isApiError(error)) {
      notVerified.value = error.code === "EMAIL_NOT_VERIFIED";
      const details = error.details as
        { remainingAttempts?: number; retryAfterSeconds?: number } | undefined;
      if (details?.remainingAttempts !== undefined) {
        remainingAttempts.value = details.remainingAttempts;
        saveAttempt();
      }
      if (
        error.code === "LOGIN_ATTEMPT_INVALID" ||
        error.code === "SESSION_CHANGED" ||
        details?.remainingAttempts === 0
      )
        forgetAttempt();
      if (error.status === 429 && details?.retryAfterSeconds)
        retryAt.value =
          Date.now() + clockOffset + details.retryAfterSeconds * 1000;
    }
  } finally {
    if (!controller.signal.aborted) {
      pending.value = false;
      await nextTick();
      if (attempt.value && !failure.value) codeInput.value?.$el.focus();
      else if (failure.value && !attempt.value)
        passwordInput.value?.$el.focus();
      else feedback.value?.focus();
    }
  }
}
</script>

<template>
  <div class="flex min-h-svh flex-col bg-background">
    <header class="flex justify-end p-6 pb-0">
      <ThemeSelect />
    </header>
    <main class="flex flex-1 items-center justify-center p-6">
      <Card class="w-full max-w-sm">
        <CardHeader class="items-center text-center">
          <HardDriveIcon class="mx-auto size-8 text-muted-foreground" />
          <CardTitle class="text-lg"> Файловое хранилище </CardTitle>
          <CardDescription>Войдите, чтобы продолжить</CardDescription>
        </CardHeader>

        <CardContent>
          <form novalidate :aria-busy="pending" @submit.prevent="submit">
            <FieldGroup>
              <template v-if="!attempt">
                <Field>
                  <FieldLabel for="email">Email</FieldLabel>
                  <Input
                    id="email"
                    v-model="email"
                    name="email"
                    type="email"
                    autocomplete="username"
                    autofocus
                    :disabled="pending"
                  />
                </Field>

                <Field>
                  <FieldLabel for="password"> Пароль </FieldLabel>
                  <InputGroup>
                    <InputGroupInput
                      id="password"
                      ref="passwordInput"
                      v-model="password"
                      name="password"
                      :type="passwordVisible ? 'text' : 'password'"
                      autocomplete="current-password"
                      :disabled="pending"
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupButton
                        size="icon-xs"
                        type="button"
                        :aria-label="
                          passwordVisible ? 'Скрыть пароль' : 'Показать пароль'
                        "
                        :aria-pressed="passwordVisible"
                        @click="passwordVisible = !passwordVisible"
                      >
                        <EyeOffIcon v-if="passwordVisible" />
                        <EyeIcon v-else />
                      </InputGroupButton>
                    </InputGroupAddon>
                  </InputGroup>
                </Field>
              </template>
              <template v-else>
                <p
                  v-if="attempt.deliveryStatus === 'unconfirmed'"
                  role="status"
                >
                  Не удалось подтвердить отправку письма. Если код пришёл,
                  введите его.
                </p>
                <p v-else role="status">
                  Почтовый сервер принял письмо. Доставка может занять время.
                </p>
                <Field>
                  <FieldLabel for="login-code">Код из письма</FieldLabel>
                  <Input
                    id="login-code"
                    ref="codeInput"
                    v-model="code"
                    name="code"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    :disabled="pending"
                    :aria-invalid="!!failure"
                    aria-describedby="login-feedback login-code-time"
                  />
                </Field>
                <p id="login-code-time">
                  {{
                    !attemptRemaining
                      ? "Попытка входа истекла. Начните новый вход."
                      : !codeRemaining
                        ? "Код истёк. Запросите новый код."
                        : `Код действует ещё ${codeRemaining} с`
                  }}
                </p>
                <p v-if="attemptRemaining">
                  Попытка действует ещё {{ attemptRemaining }} с
                </p>
                <p v-if="remainingAttempts !== null">
                  Осталось проверок: {{ remainingAttempts }}
                </p>
                <Button
                  type="button"
                  variant="outline"
                  data-action="resend"
                  :disabled="
                    pending || resendRemaining > 0 || attemptRemaining === 0
                  "
                  @click="resend"
                  >Отправить код повторно</Button
                >
                <p v-if="attemptRemaining && resendRemaining">
                  Новый код можно запросить через {{ resendRemaining }} с
                </p>
                <Button
                  type="button"
                  variant="outline"
                  :disabled="pending"
                  @click="restart"
                  >Начать новый вход</Button
                >
              </template>
              <div
                id="login-feedback"
                ref="feedback"
                tabindex="-1"
                :role="failure ? 'alert' : 'status'"
              >
                <FieldError v-if="failure">{{ failure }}</FieldError>
                <p v-if="failure && notVerified" class="text-sm">
                  Запросите новое письмо активации и откройте ссылку из него.
                  <a href="/activation" class="underline"
                    >Запросить письмо активации</a
                  >
                </p>
                <p v-if="retryRemaining">
                  Повторить можно через {{ retryRemaining }} с
                </p>
              </div>

              <Button type="submit" class="w-full" :disabled="!canSubmit">
                <Spinner v-if="pending" data-icon="inline-start" />
                {{
                  pending ? "Проверяем…" : attempt ? "Подтвердить код" : "Войти"
                }}
              </Button>
            </FieldGroup>
          </form>
          <a href="/register" class="mt-4 block text-center text-sm underline"
            >Зарегистрироваться</a
          >
          <a
            href="/password-reset"
            class="mt-2 block text-center text-sm underline"
            >Забыли пароль?</a
          >
        </CardContent>
      </Card>
    </main>
  </div>
</template>
