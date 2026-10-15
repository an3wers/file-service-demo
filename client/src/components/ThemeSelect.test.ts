import { flushPromises, mount } from "@vue/test-utils";
import { fireEvent, screen } from "@testing-library/vue";
import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryHistory, createRouter, RouterView } from "vue-router";
import ThemeSelect from "./ThemeSelect.vue";
import LoginPage from "@/pages/LoginPage.vue";
import FilesPage from "@/pages/FilesPage.vue";
import { useTheme } from "@/composables/useTheme";

beforeEach(() => {
  useTheme().setMode("system");
});

describe("выбор темы", () => {
  it("позволяет выбрать все три режима из списка", async () => {
    mount(ThemeSelect, { attachTo: document.body });
    for (const [label, mode] of [
      ["Тёмная", "dark"],
      ["Светлая", "light"],
      ["Системная", "system"],
    ]) {
      await fireEvent.pointerDown(
        screen.getByRole("combobox", { name: "Тема оформления" }),
        { button: 0, pointerType: "mouse", ctrlKey: false },
      );
      await flushPromises();
      await fireEvent.pointerUp(screen.getByRole("combobox", { hidden: true }));
      await fireEvent.pointerUp(screen.getByRole("option", { name: label }));
      await flushPromises();
      expect(useTheme().mode.value).toBe(mode);
      expect(localStorage.getItem("file-service-theme")).toBe(mode);
      expect(screen.getByRole("combobox").textContent).toContain(label);
    }
  });

  it("открывает список и выбирает тему с клавиатуры", async () => {
    mount(ThemeSelect, { attachTo: document.body });
    const trigger = screen.getByRole("combobox", { name: "Тема оформления" });
    trigger.focus();
    await fireEvent.keyDown(trigger, { key: "Enter" });
    await flushPromises();
    const option = screen.getByRole("option", { name: "Тёмная" });
    option.focus();
    await fireEvent.keyDown(option, { key: "Enter" });
    await flushPromises();
    expect(useTheme().mode.value).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("сохраняет выбранную тему при переходах между входом и хранилищем", async () => {
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [
        { path: "/login", component: LoginPage },
        { path: "/", component: FilesPage },
      ],
    });
    await router.push("/login");
    await router.isReady();
    mount(RouterView, {
      attachTo: document.body,
      global: {
        plugins: [router],
        stubs: { FileBrowser: true, FeaturesSection: true },
      },
    });
    await fireEvent.pointerDown(
      screen.getByRole("combobox", { name: "Тема оформления" }),
      { button: 0, pointerType: "mouse", ctrlKey: false },
    );
    await flushPromises();
    await fireEvent.pointerUp(screen.getByRole("combobox", { hidden: true }));
    await fireEvent.pointerUp(screen.getByRole("option", { name: "Тёмная" }));
    await flushPromises();
    await router.push("/");
    await flushPromises();
    expect(
      screen.getByRole("combobox", { name: "Тема оформления" }).textContent,
    ).toContain("Тёмная");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    await router.push("/login");
    await flushPromises();
    expect(
      screen.getByRole("combobox", { name: "Тема оформления" }).textContent,
    ).toContain("Тёмная");
  });
});
