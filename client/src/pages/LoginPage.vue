<script setup lang="ts">
import { computed, nextTick, ref, useTemplateRef } from "vue"
import { useRouter } from "vue-router"
import { EyeIcon, EyeOffIcon, HardDriveIcon } from "@lucide/vue"
import { isApiError } from "@/api/client"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupInput,
} from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { useAuth } from "@/composables/useAuth"
import { errorMessage } from "@/lib/errors"

const auth = useAuth()
const router = useRouter()

const login = ref("")
const password = ref("")
const passwordVisible = ref(false)
const pending = ref(false)
const failure = ref<string | null>(null)
const passwordInput = useTemplateRef<{ $el: HTMLInputElement }>("passwordInput")

const canSubmit = computed(
  () => login.value.trim() !== "" && password.value !== "" && !pending.value,
)

async function submit(): Promise<void> {
  if (!canSubmit.value) {
    return
  }

  pending.value = true
  failure.value = null

  try {
    await auth.login(login.value.trim(), password.value)
  } catch (error) {
    pending.value = false
    failure.value = errorMessage(error, "Не удалось войти")

    if (isApiError(error) && error.code === "INVALID_CREDENTIALS") {
      password.value = ""
      await nextTick()
      passwordInput.value?.$el.focus()
    }

    return
  }

  pending.value = false
  await router.push({ name: "files" })
}
</script>

<template>
  <main class="flex min-h-svh items-center justify-center bg-background p-6">
    <Card class="w-full max-w-sm">
      <CardHeader class="items-center text-center">
        <HardDriveIcon class="mx-auto size-8 text-muted-foreground" />
        <CardTitle class="text-lg">
          Файловое хранилище
        </CardTitle>
        <CardDescription>Войдите, чтобы продолжить</CardDescription>
      </CardHeader>

      <CardContent>
        <form
          novalidate
          @submit.prevent="submit"
        >
          <FieldGroup>
            <Field>
              <FieldLabel for="login">
                Логин
              </FieldLabel>
              <Input
                id="login"
                v-model="login"
                name="login"
                autocomplete="username"
                autofocus
                :disabled="pending"
              />
            </Field>

            <Field>
              <FieldLabel for="password">
                Пароль
              </FieldLabel>
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
                    :aria-label="passwordVisible ? 'Скрыть пароль' : 'Показать пароль'"
                    :aria-pressed="passwordVisible"
                    @click="passwordVisible = !passwordVisible"
                  >
                    <EyeOffIcon v-if="passwordVisible" />
                    <EyeIcon v-else />
                  </InputGroupButton>
                </InputGroupAddon>
              </InputGroup>
            </Field>

            <FieldError v-if="failure">
              {{ failure }}
            </FieldError>

            <Button
              type="submit"
              class="w-full"
              :disabled="!canSubmit"
            >
              <Spinner
                v-if="pending"
                data-icon="inline-start"
              />
              Войти
            </Button>
          </FieldGroup>
        </form>
      </CardContent>
    </Card>
  </main>
</template>
