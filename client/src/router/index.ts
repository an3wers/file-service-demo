import { createRouter } from "vue-router"
import type { RouteRecordRaw, RouterHistory } from "vue-router"
import type { Auth, SignOutReason } from "@/composables/useAuth"
import LoginPage from "@/pages/LoginPage.vue"

declare module "vue-router" {
  interface RouteMeta {
    requiresAuth?: boolean
    guestOnly?: boolean
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: "/login",
    name: "login",
    component: LoginPage,
    meta: { guestOnly: true },
  },
  {
    path: "/",
    name: "files",
    component: () => import("@/pages/FilesPage.vue"),
    meta: { requiresAuth: true },
  },
  { path: "/:pathMatch(.*)*", redirect: "/" },
]

const SIGN_OUT_NOTICES: Partial<Record<SignOutReason, string>> = {
  expired: "Сессия истекла — войдите снова",
  elsewhere: "Вы вышли в другой вкладке",
}

export interface AppRouterOptions {
  history: RouterHistory
  auth: Auth
  upload: { cancel(): void }
  browser: { reset(): void }
  notify: (message: string) => void
}

export function createAppRouter({
  history,
  auth,
  upload,
  browser,
  notify,
}: AppRouterOptions) {
  const router = createRouter({ history, routes })

  router.beforeEach(async (to) => {
    await auth.ensureSession()

    if (auth.status.value === "failed") {
      return true
    }

    if (to.meta.requiresAuth && !auth.signedIn.value) {
      return { name: "login" }
    }

    if (to.meta.guestOnly && auth.signedIn.value) {
      return { name: "files" }
    }

    return true
  })

  auth.onSignOut((reason) => {
    upload.cancel()

    if (reason !== "expired") {
      browser.reset()
    }

    const notice = SIGN_OUT_NOTICES[reason]

    if (notice) {
      notify(notice)
    }

    void router.push({ name: "login" })
  })

  auth.onSignInElsewhere(async () => {
    if (router.currentRoute.value.name !== "login") {
      return
    }

    if (await auth.renew()) {
      await router.push({ name: "files" })
    }
  })

  return router
}
