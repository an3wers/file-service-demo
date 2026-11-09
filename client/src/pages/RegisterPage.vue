<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  ref,
  useTemplateRef,
  watch,
} from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { EyeIcon, EyeOffIcon, HardDriveIcon } from "@lucide/vue";
import type { RegistrationAttempt } from "@/api/generated";
import { register, resendRegistration } from "@/api/auth";
import {
  isApiError,
  restoreServerClockOffset,
  serverClockOffsetMs,
  serverNow,
} from "@/api/client";
import {
  clearStoredRegistration,
  readStoredRegistration,
  writeStoredRegistration,
} from "@/lib/registrationAttempt";
import { readSharedAuth } from "@/api/sharedAuth";
import { useAuth } from "@/composables/useAuth";
import { safeReturnTo } from "@/lib/returnTo";
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
import { errorMessage } from "@/lib/errors";

interface ErrorDetails {
  fieldErrors?: Record<string, string[]>;
  remainingAttempts?: number;
  retryAfterSeconds?: number;
}
const detailsOf = (error: { details?: unknown }) =>
  (error.details ?? {}) as ErrorDetails;

const auth = useAuth();
const router = useRouter();
const route = useRoute();
const attempt = ref<RegistrationAttempt | null>(null);
const submittedEmail = ref("");
const code = ref("");
const remainingAttempts = ref<number | null>(null);
const ended = ref(false);
let generation = readSharedAuth().generation;

// Восстановление выполняется до первого чтения серверного времени: смещение
// часов устройства переживает обновление, а сроки попытки остаются прежними.
function restoreAttempt() {
  const stored = readStoredRegistration();
  if (!stored) return;
  restoreServerClockOffset(stored.clockOffset);
  submittedEmail.value = stored.email;
  const shared = readSharedAuth();
  const sameLogin = !shared.signedIn && shared.generation === stored.generation;
  if (
    !sameLogin ||
    Date.parse(stored.attempt.attemptExpiresAt) <= serverNow()
  ) {
    ended.value = true;
    clearStoredRegistration();
    return;
  }
  generation = stored.generation;
  attempt.value = stored.attempt;
  remainingAttempts.value = stored.remainingAttempts;
}
restoreAttempt();
const now = ref(serverNow());
const secondsLeft = (until: string | undefined) =>
  Math.max(0, Math.ceil((Date.parse(until ?? "") - now.value) / 1000));
const codeRemaining = computed(() => secondsLeft(attempt.value?.codeExpiresAt));
const attemptRemaining = computed(() =>
  secondsLeft(attempt.value?.attemptExpiresAt),
);
const clock = setInterval(() => {
  now.value = serverNow();
}, 1000);

function saveAttempt() {
  if (!attempt.value) return;
  writeStoredRegistration({
    attempt: attempt.value,
    email: submittedEmail.value,
    generation,
    remainingAttempts: remainingAttempts.value,
    clockOffset: serverClockOffsetMs(),
  });
}
function forgetAttempt() {
  code.value = "";
  clearStoredRegistration();
}
function endAttempt() {
  ended.value = true;
  attempt.value = null;
  forgetAttempt();
}
watch(attemptRemaining, (left) => {
  if (attempt.value && left === 0) endAttempt();
});
const stopWatchingSignIn = auth.onSignInElsewhere(() => {
  if (attempt.value) endAttempt();
});
async function onCodeInput(value: string | number) {
  fieldErrors.value.code = [];
  await nextTick();
  code.value = String(value).replace(/\D/g, "").slice(0, 6);
}

const name = ref("");
const email = ref("");
const password = ref("");
const visible = ref(false);
const pending = ref(false);
const failure = ref("");
const fieldErrors = ref<Record<string, string[]>>({});
const retryAfterSeconds = ref(0);
const form = useTemplateRef<HTMLFormElement>("form");
const resultElement = useTemplateRef<HTMLDivElement>("resultElement");
const canVerify = computed(
  () =>
    !pending.value &&
    !ended.value &&
    /^[0-9]{6}$/.test(code.value) &&
    attemptRemaining.value > 0,
);
const controller = new AbortController();
let timer: ReturnType<typeof setInterval> | undefined;
const canSubmit = computed(
  () =>
    !!name.value.trim() &&
    !!email.value.trim() &&
    !!password.value &&
    !pending.value &&
    retryAfterSeconds.value === 0,
);

function countdown(seconds: number) {
  clearInterval(timer);
  retryAfterSeconds.value = seconds;
  timer = setInterval(() => {
    retryAfterSeconds.value = Math.max(0, retryAfterSeconds.value - 1);
    if (retryAfterSeconds.value === 0) clearInterval(timer);
  }, 1000);
}

async function submit() {
  if (!canSubmit.value) return;
  pending.value = true;
  failure.value = "";
  fieldErrors.value = {};
  try {
    const started = readSharedAuth().generation;
    const response = await register(
      { name: name.value, email: email.value, password: password.value },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    password.value = "";
    visible.value = false;
    generation = started;
    now.value = serverNow();
    submittedEmail.value = email.value.trim();
    remainingAttempts.value = null;
    ended.value = false;
    attempt.value = response;
    saveAttempt();
    await nextTick();
    resultElement.value?.focus();
  } catch (error) {
    if (controller.signal.aborted) return;
    pending.value = false;
    failure.value = errorMessage(error, "Не удалось выполнить регистрацию");
    if (isApiError(error)) {
      const details = detailsOf(error);
      fieldErrors.value = details.fieldErrors ?? {};
      if (error.status === 429 && details.retryAfterSeconds)
        countdown(details.retryAfterSeconds);
    }
    await nextTick();
    (
      form.value?.querySelector("[aria-invalid=true]") ??
      form.value?.querySelector("[role=alert]")
    )?.scrollIntoView?.({ block: "nearest" });
    const firstInvalid = form.value?.querySelector<HTMLInputElement>(
      "[aria-invalid=true]",
    );
    firstInvalid?.focus();
  } finally {
    pending.value = false;
  }
}

async function finishRegistration() {
  attempt.value = null;
  forgetAttempt();
  await router.push(safeReturnTo(route.query.returnTo));
}

async function verify() {
  if (!attempt.value || !canVerify.value) return;
  pending.value = true;
  failure.value = "";
  fieldErrors.value = {};
  try {
    await auth.verifyRegistration(
      attempt.value.attemptToken,
      code.value,
      generation,
    );
    if (controller.signal.aborted) return;
    await finishRegistration();
  } catch (error) {
    if (controller.signal.aborted) return;
    if (isApiError(error) && error.code === "LOGIN_CODE_EXPIRED") {
      fieldErrors.value.code = [
        "Срок действия кода истёк. Запросите письмо повторно.",
      ];
    } else if (isApiError(error) && error.code === "LOGIN_CODE_INVALID") {
      fieldErrors.value.code = [errorMessage(error)];
    } else {
      failure.value = errorMessage(error, "Не удалось подтвердить код");
    }
    if (isApiError(error) && (error.status === 0 || error.status >= 500)) {
      // Ответ мог потеряться уже после создания сессии, поэтому сначала
      // пробуем получить её по refresh-cookie; код при этом не считаем неверным.
      const recovered = await auth.recoverRegistrationSession(generation);
      if (controller.signal.aborted) return;
      if (recovered === "restored") {
        failure.value = "";
        await finishRegistration();
        return;
      }
      // Временный сбой не означает неверный код: попытку завершаем, только
      // если общий вход сменился и секрет уже непригоден.
      if (
        recovered === "absent" &&
        readSharedAuth().generation !== generation
      ) {
        failure.value = "";
        endAttempt();
      }
    } else if (isApiError(error)) {
      const details = detailsOf(error);
      if (details.remainingAttempts !== undefined) {
        remainingAttempts.value = details.remainingAttempts;
        saveAttempt();
      }
      if (
        error.code === "LOGIN_ATTEMPT_INVALID" ||
        error.code === "SESSION_CHANGED" ||
        details.remainingAttempts === 0
      ) {
        ended.value = true;
        forgetAttempt();
      }
      if (error.status === 429 && details.retryAfterSeconds)
        countdown(details.retryAfterSeconds);
    }
    pending.value = false;
    await nextTick();
    if (fieldErrors.value.code?.length) {
      resultElement.value
        ?.querySelector<HTMLInputElement>("[name=code]")
        ?.focus();
    } else {
      resultElement.value?.focus();
    }
  } finally {
    pending.value = false;
  }
}

const resendRemaining = computed(() =>
  Math.max(codeRemaining.value, secondsLeft(attempt.value?.resendAvailableAt)),
);
async function resend() {
  if (
    !attempt.value ||
    pending.value ||
    ended.value ||
    resendRemaining.value > 0
  )
    return;
  pending.value = true;
  failure.value = "";
  try {
    const response = await resendRegistration(
      attempt.value.attemptToken,
      controller.signal,
    );
    if (controller.signal.aborted || !attempt.value) return;
    now.value = serverNow();
    attempt.value = { ...attempt.value, ...response };
    code.value = "";
    fieldErrors.value = {};
    saveAttempt();
  } catch (error) {
    if (controller.signal.aborted) return;
    failure.value = errorMessage(error, "Не удалось запросить письмо");
    if (isApiError(error)) {
      const details = detailsOf(error);
      if (error.code === "LOGIN_ATTEMPT_INVALID") {
        endAttempt();
      } else if (
        error.status === 429 &&
        details.retryAfterSeconds &&
        attempt.value
      ) {
        now.value = serverNow();
        attempt.value = {
          ...attempt.value,
          resendAvailableAt: new Date(
            now.value + details.retryAfterSeconds * 1000,
          ).toISOString(),
        };
        saveAttempt();
      }
    }
    await nextTick();
    resultElement.value?.focus();
  } finally {
    pending.value = false;
  }
}

async function changeEmail() {
  attempt.value = null;
  ended.value = false;
  failure.value = "";
  fieldErrors.value = {};
  forgetAttempt();
  password.value = "";
  await nextTick();
  form.value?.querySelector<HTMLInputElement>("[name=email]")?.focus();
}

onBeforeUnmount(() => {
  password.value = "";
  controller.abort();
  clearInterval(timer);
  clearInterval(clock);
  stopWatchingSignIn();
});
</script>

<template>
  <div class="flex min-h-svh flex-col bg-background">
    <header class="flex justify-end p-6 pb-0"><ThemeSelect /></header>
    <main class="flex flex-1 items-center justify-center p-6">
      <Card class="w-full max-w-sm">
        <CardHeader class="items-center text-center">
          <HardDriveIcon class="mx-auto size-8 text-muted-foreground" />
          <CardTitle class="text-lg">Регистрация</CardTitle>
          <CardDescription
            >Создайте доступ к файловому хранилищу</CardDescription
          >
        </CardHeader>
        <CardContent>
          <div
            v-if="attempt || ended"
            ref="resultElement"
            tabindex="-1"
            class="space-y-4"
          >
            <p>
              Для продолжения следуйте инструкциям в письме на
              <strong>{{ submittedEmail }}</strong
              >.
            </p>
            <p v-if="ended" role="status">
              Попытка завершена. Войдите или восстановите доступ.
            </p>
            <form novalidate :aria-busy="pending" @submit.prevent="verify">
              <FieldGroup>
                <Field>
                  <FieldLabel for="registration-code"
                    >Код подтверждения</FieldLabel
                  >
                  <Input
                    id="registration-code"
                    v-model="code"
                    name="code"
                    type="text"
                    inputmode="numeric"
                    autocomplete="one-time-code"
                    maxlength="12"
                    :disabled="pending || ended"
                    :aria-invalid="!!fieldErrors.code?.length"
                    aria-describedby="registration-code-error registration-feedback"
                    @update:model-value="onCodeInput"
                  />
                  <FieldError id="registration-code-error" role="alert">{{
                    fieldErrors.code?.join(". ")
                  }}</FieldError>
                </Field>
                <div id="registration-feedback" role="status">
                  <FieldError v-if="failure" role="alert">{{
                    failure
                  }}</FieldError>
                  <p v-if="remainingAttempts !== null">
                    Осталось проверок: {{ remainingAttempts }}
                  </p>
                  <p v-if="retryAfterSeconds">
                    Повторить можно через {{ retryAfterSeconds }} с
                  </p>
                </div>
                <Button type="submit" :disabled="!canVerify">
                  <Spinner v-if="pending" data-icon="inline-start" />
                  {{ pending ? "Проверяем…" : "Продолжить" }}
                </Button>
              </FieldGroup>
            </form>
            <p class="text-sm text-muted-foreground">
              Письмо не пришло? Проверьте папку «Спам» или запросите его
              повторно после окончания ожидания.
            </p>
            <Button
              type="button"
              variant="outline"
              data-action="resend"
              :disabled="pending || ended || resendRemaining > 0"
              @click="resend"
              >Отправить письмо повторно</Button
            >
            <p v-if="!ended && resendRemaining > 0" role="status">
              Письмо можно запросить повторно через {{ resendRemaining }} с
            </p>
            <Button
              type="button"
              variant="outline"
              data-change-email
              @click="changeEmail"
              >Изменить email</Button
            >
            <p class="text-sm">
              Уже пользовались сервисом?
              <RouterLink to="/login" class="underline">Войти</RouterLink> ·
              <RouterLink to="/password-reset" class="underline"
                >Восстановить доступ</RouterLink
              >
            </p>
          </div>
          <form
            v-else
            ref="form"
            novalidate
            :aria-busy="pending"
            @submit.prevent="submit"
          >
            <FieldGroup>
              <Field>
                <FieldLabel for="name">Имя</FieldLabel>
                <Input
                  id="name"
                  v-model="name"
                  name="name"
                  autocomplete="name"
                  autofocus
                  :disabled="pending"
                  :aria-invalid="!!fieldErrors.name?.length"
                  aria-describedby="name-error"
                />
                <FieldError id="name-error">{{
                  fieldErrors.name?.join(". ")
                }}</FieldError>
              </Field>
              <Field>
                <FieldLabel for="email">Email</FieldLabel>
                <Input
                  id="email"
                  v-model="email"
                  name="email"
                  type="email"
                  autocomplete="username"
                  :disabled="pending"
                  :aria-invalid="!!fieldErrors.email?.length"
                  aria-describedby="email-error"
                />
                <FieldError id="email-error">{{
                  fieldErrors.email?.join(". ")
                }}</FieldError>
              </Field>
              <Field>
                <FieldLabel for="password">Пароль</FieldLabel>
                <InputGroup>
                  <InputGroupInput
                    id="password"
                    v-model="password"
                    name="password"
                    :type="visible ? 'text' : 'password'"
                    autocomplete="new-password"
                    minlength="12"
                    passwordrules="minlength: 12; maxlength: 128;"
                    :disabled="pending"
                    :aria-invalid="!!fieldErrors.password?.length"
                    aria-describedby="password-help password-error"
                  />
                  <InputGroupAddon align="inline-end">
                    <InputGroupButton
                      type="button"
                      size="icon-xs"
                      :aria-label="
                        visible ? 'Скрыть пароль' : 'Показать пароль'
                      "
                      :aria-pressed="visible"
                      @click="visible = !visible"
                    >
                      <EyeOffIcon v-if="visible" /><EyeIcon v-else />
                    </InputGroupButton>
                  </InputGroupAddon>
                </InputGroup>
                <p id="password-help" class="text-sm text-muted-foreground">
                  От 12 до 128 символов. Пробелы разрешены.
                </p>
                <FieldError id="password-error">{{
                  fieldErrors.password?.join(". ")
                }}</FieldError>
              </Field>
              <FieldError v-if="failure" role="alert">{{ failure }}</FieldError>
              <p v-if="retryAfterSeconds" role="status">
                Повторить можно через {{ retryAfterSeconds }} с
              </p>
              <Button type="submit" :disabled="!canSubmit">
                <Spinner v-if="pending" data-icon="inline-start" />
                {{ pending ? "Обрабатываем запрос…" : "Зарегистрироваться" }}
              </Button>
              <RouterLink to="/login" class="text-center text-sm underline"
                >Перейти ко входу</RouterLink
              >
              <RouterLink
                to="/password-reset"
                class="text-center text-sm underline"
                >Восстановить доступ</RouterLink
              >
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
