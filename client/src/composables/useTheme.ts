import {
  computed,
  effectScope,
  onScopeDispose,
  readonly,
  shallowRef,
  watch,
} from "vue";

export type ThemeMode = "light" | "dark" | "system";

const storageKey = "file-service-theme";

function readMode(): ThemeMode {
  try {
    const value = localStorage.getItem(storageKey);
    if (value === "light" || value === "dark") {
      return value;
    }
  } catch {
    return "system";
  }

  return "system";
}

export function createTheme() {
  const mode = shallowRef<ThemeMode>(readMode());
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const systemDark = shallowRef(media.matches);
  const resolvedTheme = computed<"light" | "dark">(() =>
    mode.value === "system"
      ? systemDark.value
        ? "dark"
        : "light"
      : mode.value,
  );

  function updateSystem(event: MediaQueryListEvent): void {
    systemDark.value = event.matches;
  }

  media.addEventListener("change", updateSystem);
  onScopeDispose(() => media.removeEventListener("change", updateSystem));

  watch(
    resolvedTheme,
    (theme) => {
      document.documentElement.classList.toggle("dark", theme === "dark");
      document.documentElement.style.colorScheme = theme;
    },
    { immediate: true, flush: "sync" },
  );

  function setMode(value: ThemeMode): void {
    mode.value = value;
    try {
      localStorage.setItem(storageKey, value);
    } catch {
      return;
    }
  }

  return { mode: readonly(mode), resolvedTheme, setMode };
}

let instance: ReturnType<typeof createTheme> | undefined;

export function useTheme() {
  instance ??= effectScope(true).run(createTheme)!;
  return instance;
}
