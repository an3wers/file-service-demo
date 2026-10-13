import { beforeEach, describe, expect, it } from "vitest"
import { mount } from "@vue/test-utils"
import { fireEvent, screen, within } from "@testing-library/vue"
import FileTable from "./FileTable.vue"
import { useFileBrowser } from "@/composables/useFileBrowser"
import type { FileDto } from "@/types/api"

const file: FileDto = {
  id: "c3346aa8-ad3d-4e74-8c13-8c7a04078a72",
  name: "отчёт.txt",
  directory: "",
  extension: "txt",
  contentType: "text/plain",
  size: 1024,
  etag: null,
  status: "ready",
  uploadSource: "server",
  bucket: "test",
  key: "file.txt",
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
}

beforeEach(() => {
  useFileBrowser().reset()
  useFileBrowser().files.value = [file]
})

describe("единая таблица каталогов и файлов", () => {
  it("скачивает и удаляет файл без открытия карточки", async () => {
    const wrapper = mount(FileTable, { attachTo: document.body })
    await fireEvent.click(screen.getByRole("button", { name: "Скачать файл" }))
    await fireEvent.click(screen.getByRole("button", { name: "Удалить файл" }))
    expect(wrapper.emitted("download")).toEqual([[file]])
    expect(wrapper.emitted("remove")).toEqual([[file]])
    expect(wrapper.emitted("open")).toBeUndefined()
  })

  it("открывает карточку один раз при нажатии на название и при нажатии на строку", async () => {
    const wrapper = mount(FileTable, { attachTo: document.body })
    const name = screen.getByRole("button", { name: file.name })
    name.focus()
    expect(document.activeElement).toBe(name)
    await fireEvent.click(name)
    expect(wrapper.emitted("open")).toEqual([[file]])
    await fireEvent.click(screen.getByRole("row", { name: /отчёт.txt/ }))
    expect(wrapper.emitted("open")).toEqual([[file], [file]])
  })

  it("заменяет каталоги и файлы общим скелетом во время загрузки", () => {
    const browser = useFileBrowser()
    browser.directories.value = [{ name: "Документы", path: "Документы", fileCount: 1 }]
    browser.loading.value = true
    mount(FileTable, { attachTo: document.body })
    const table = screen.getByRole("table", { name: "Каталоги и файлы" })
    const rows = within(table).getAllByRole("row").slice(1)
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(within(row).getAllByRole("cell")).toHaveLength(4)
    expect(screen.queryByRole("button", { name: "Документы" })).toBeNull()
    expect(screen.queryByRole("button", { name: file.name })).toBeNull()
    expect(screen.queryByText("Здесь пока пусто")).toBeNull()
  })
})
