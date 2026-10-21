<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, useTemplateRef } from "vue";
import { EyeIcon, EyeOffIcon, HardDriveIcon } from "@lucide/vue";
import { register } from "@/api/auth";
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
import { errorMessage } from "@/lib/errors";

const name = ref("");
const email = ref("");
const password = ref("");
const visible = ref(false);
const pending = ref(false);
const result = ref("");
const failure = ref("");
const fieldErrors = ref<Record<string, string[]>>({});
const retryAfterSeconds = ref(0);
const form = useTemplateRef<HTMLFormElement>("form");
const resultElement = useTemplateRef<HTMLDivElement>("resultElement");
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
    const response = await register(
      { name: name.value, email: email.value, password: password.value },
      controller.signal,
    );
    if (controller.signal.aborted) return;
    password.value = "";
    visible.value = false;
    result.value = response.message;
    await nextTick();
    resultElement.value?.focus();
  } catch (error) {
    if (controller.signal.aborted) return;
    pending.value = false;
    failure.value = errorMessage(error, "Не удалось выполнить регистрацию");
    if (isApiError(error)) {
      const details = error.details as
        | { fieldErrors?: Record<string, string[]>; retryAfterSeconds?: number }
        | undefined;
      fieldErrors.value = details?.fieldErrors ?? {};
      if (error.status === 429 && details?.retryAfterSeconds)
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

async function changeEmail() {
  result.value = "";
  password.value = "";
  await nextTick();
  form.value?.querySelector<HTMLInputElement>("[name=email]")?.focus();
}

onBeforeUnmount(() => {
  password.value = "";
  controller.abort();
  clearInterval(timer);
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
            v-if="result"
            ref="resultElement"
            tabindex="-1"
            role="status"
            class="space-y-4"
          >
            <p>{{ result }}</p>
            <Button
              type="button"
              variant="outline"
              data-change-email
              @click="changeEmail"
              >Изменить email</Button
            >
            <a href="/login" class="block text-sm underline"
              >Перейти ко входу</a
            >
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
                  autocomplete="email"
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
              <a href="/login" class="text-center text-sm underline"
                >Перейти ко входу</a
              >
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </main>
  </div>
</template>
