import html from "../../index.html?raw";
import { effectScope, type EffectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTheme, type ThemeMode } from "./useTheme";

let scope: EffectScope;
let media: MediaQueryList;

function startTheme() {
  scope = effectScope();
  return scope.run(createTheme)!;
}

function changeSystem(dark: boolean) {
  Object.defineProperty(media, "matches", { value: dark, configurable: true });
  const event = new Event("change");
  Object.defineProperty(event, "matches", { value: dark });
  media.dispatchEvent(event);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  media = Object.assign(new EventTarget(), {
    matches: false,
  }) as MediaQueryList;
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => media),
  );
});

afterEach(() => {
  scope?.stop();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
});

describe("тема оформления", () => {
  it("при первом посещении следует теме ОС и реагирует на её изменения", () => {
    changeSystem(true);
    const theme = startTheme();
    expect(theme.mode.value).toBe("system");
    expect(theme.resolvedTheme.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");

    changeSystem(false);
    expect(theme.resolvedTheme.value).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it.each<ThemeMode>(["light", "dark", "system"])(
    "сохраняет и восстанавливает режим %s",
    (mode) => {
      const theme = startTheme();
      theme.setMode(mode);
      expect(localStorage.getItem("file-service-theme")).toBe(mode);
      scope.stop();

      expect(startTheme().mode.value).toBe(mode);
    },
  );

  it("при ручном выборе игнорирует тему ОС и возобновляет слежение в системном режиме", () => {
    const theme = startTheme();
    theme.setMode("light");
    changeSystem(true);
    expect(theme.resolvedTheme.value).toBe("light");
    theme.setMode("dark");
    changeSystem(false);
    expect(theme.resolvedTheme.value).toBe("dark");
    theme.setMode("system");
    expect(theme.resolvedTheme.value).toBe("light");
    changeSystem(true);
    expect(theme.resolvedTheme.value).toBe("dark");
  });

  it("при некорректном сохранённом значении использует системный режим", () => {
    localStorage.setItem("file-service-theme", "invalid");
    changeSystem(true);
    expect(startTheme().resolvedTheme.value).toBe("dark");
  });

  it("переключает тему при недоступном хранилище браузера", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const theme = startTheme();
    expect(theme.mode.value).toBe("system");
    theme.setMode("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    theme.setMode("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });

  it("отписывается от изменений ОС при завершении области эффектов", () => {
    const theme = startTheme();
    scope.stop();
    changeSystem(true);
    expect(theme.resolvedTheme.value).toBe("light");
  });
});

describe("тема до запуска приложения", () => {
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1]!;

  it.each([
    ["dark", false, "dark"],
    ["light", true, "light"],
    ["system", true, "dark"],
    [null, false, "light"],
    ["invalid", true, "dark"],
  ])(
    "применяет сохранённый режим %s при теме ОС %s",
    (saved, systemDark, expected) => {
      new Function("document", "localStorage", "matchMedia", script)(
        document,
        { getItem: () => saved },
        () => ({ matches: systemDark }),
      );
      expect(document.documentElement.classList.contains("dark")).toBe(
        expected === "dark",
      );
      expect(document.documentElement.style.colorScheme).toBe(expected);
    },
  );

  it("применяет системную тему при запрете доступа к хранилищу", () => {
    new Function("document", "localStorage", "matchMedia", script)(
      document,
      {
        getItem: () => {
          throw new Error("denied");
        },
      },
      () => ({ matches: true }),
    );
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });
});
