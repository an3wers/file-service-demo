import { describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { Button } from "@/components/ui/button"

// Дымовой тест самой обвязки: проверяет, что SFC компилируются, алиас `@`
// резолвится и DOM от happy-dom доступен. Прикладной логики здесь нет.
describe("test setup", () => {
  it("монтирует SFC через алиас `@`", () => {
    const wrapper = mount(Button, {
      props: { variant: "outline" },
      slots: { default: "Загрузить" },
    })

    expect(wrapper.element.tagName).toBe("BUTTON")
    expect(wrapper.text()).toBe("Загрузить")
    expect(wrapper.attributes("data-variant")).toBe("outline")
  })
})
