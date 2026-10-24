import { createRouter } from "vue-router";
import type { RouteRecordRaw, RouterHistory } from "vue-router";
import type { Auth, SignOutReason } from "@/composables/useAuth";
import LoginPage from "@/pages/LoginPage.vue";

declare module "vue-router" {
  interface RouteMeta {
    requiresAuth?: boolean;
    guestOnly?: boolean;
  }
}

const routes: RouteRecordRaw[] = [
  {
    path: "/activation",
    name: "activation",
    component: () => import("@/pages/ActivationPage.vue"),
  },
  {
    path: "/register",
    name: "register",
    component: () => import("@/pages/RegisterPage.vue"),
    meta: { guestOnly: true },
  },
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
];

const SIGN_OUT_NOTICES: Partial<Record<SignOutReason, string>> = {
  expired: "Сессия истекла — войдите снова",
  elsewhere: "Вы вышли в другой вкладке",
};

export interface AppRouterOptions {
  history: RouterHistory;
  auth: Auth;
  upload: { stop(): void; reset(): void };
  browser: { reset(): void };
  notify: (message: string) => void;
}

export function createAppRouter({
  history,
  auth,
  upload,
  browser,
  notify,
}: AppRouterOptions) {
  const router = createRouter({ history, routes });

  router.beforeEach(async (to) => {
    if (to.name === "activation" && to.hash) {
      const token = new URLSearchParams(to.hash.slice(1)).get("token");
      router.options.history.replace(
        router.resolve({ path: to.path, query: to.query, hash: "" }).fullPath,
      );
      try {
        sessionStorage.removeItem("file-service-activation-token");
        sessionStorage.removeItem("file-service-activation-form");
        if (token)
          sessionStorage.setItem("file-service-activation-token", token);
      } catch {
        return { path: to.path, query: to.query, hash: "", replace: true };
      }
      return { path: to.path, query: to.query, hash: "", replace: true };
    }
    if (to.name === "activation") return true;
    await auth.ensureSession();

    if (auth.status.value === "failed") {
      return true;
    }

    if (to.meta.requiresAuth && !auth.signedIn.value) {
      return { name: "login", query: { returnTo: to.fullPath } };
    }

    if (to.meta.guestOnly && auth.signedIn.value) {
      return { name: "files" };
    }

    return true;
  });

  auth.onSignOut((reason) => {
    upload.stop();
    if (reason !== "expired") browser.reset();

    const notice = SIGN_OUT_NOTICES[reason];

    if (notice) {
      notify(notice);
    }

    if (router.currentRoute.value.name !== "activation")
      void router.push({ name: "login" });
  });

  auth.onSignInElsewhere(async () => {
    if (router.currentRoute.value.name !== "login") {
      return;
    }

    if (await auth.renew()) {
      await router.push({ name: "files" });
    }
  });

  return router;
}
