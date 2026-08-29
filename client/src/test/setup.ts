import { afterEach } from "vitest"
import { enableAutoUnmount } from "@vue/test-utils"

// Каждый mount снимается после теста: иначе висящие компоненты продолжают
// держать watch/таймеры и текут между тест-кейсами одного файла.
enableAutoUnmount(afterEach)

// happy-dom не реализует API, на которые опирается reka-ui (основа shadcn-vue):
// без заглушек любой Dialog/Popover падает ещё на монтировании.
if (!globalThis.matchMedia) {
  globalThis.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as unknown as MediaQueryList
}

class ObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}

globalThis.ResizeObserver ??= ObserverStub as unknown as typeof ResizeObserver
globalThis.IntersectionObserver ??=
  ObserverStub as unknown as typeof IntersectionObserver

Element.prototype.scrollIntoView ??= () => {}
Element.prototype.hasPointerCapture ??= () => false
Element.prototype.setPointerCapture ??= () => {}
Element.prototype.releasePointerCapture ??= () => {}
