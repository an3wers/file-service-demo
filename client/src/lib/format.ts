import type { Component } from "vue"
import {
  FileArchiveIcon,
  FileCodeIcon,
  FileIcon,
  FileImageIcon,
  FileMusicIcon,
  FileSpreadsheetIcon,
  FileTextIcon,
  FileVideoCameraIcon,
} from "@lucide/vue"
import type { FileDto } from "@/types/api"

// Форматтеры Intl.* дорогие в конструировании — создаём по одному на модуль.
const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
  dateStyle: "short",
  timeStyle: "short",
})
const pluralRules = new Intl.PluralRules("ru-RU")

const UNITS = ["Б", "КБ", "МБ", "ГБ", "ТБ"]

export function formatBytes(bytes: number | null): string {
  if (bytes === null || Number.isNaN(bytes)) {
    return "—"
  }

  if (bytes < 1024) {
    return `${bytes} ${UNITS[0]}`
  }

  let value = bytes
  let unit = 0

  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024
    unit += 1
  }

  return `${value.toFixed(1)} ${UNITS[unit]}`
}

export function formatDate(iso: string): string {
  const date = new Date(iso)

  return Number.isNaN(date.getTime()) ? "—" : dateFormatter.format(date)
}

/** `plural(3, ["файл", "файла", "файлов"])` → «файла». */
export function plural(count: number, forms: [string, string, string]): string {
  const category = pluralRules.select(count)

  if (category === "one") {
    return forms[0]
  }

  return category === "few" ? forms[1] : forms[2]
}

const EXTENSION_ICONS: Record<string, Component> = {
  pdf: FileTextIcon,
  doc: FileTextIcon,
  docx: FileTextIcon,
  rtf: FileTextIcon,
  md: FileTextIcon,
  txt: FileTextIcon,
  xls: FileSpreadsheetIcon,
  xlsx: FileSpreadsheetIcon,
  csv: FileSpreadsheetIcon,
  zip: FileArchiveIcon,
  rar: FileArchiveIcon,
  "7z": FileArchiveIcon,
  tar: FileArchiveIcon,
  gz: FileArchiveIcon,
  js: FileCodeIcon,
  ts: FileCodeIcon,
  json: FileCodeIcon,
  xml: FileCodeIcon,
  html: FileCodeIcon,
  css: FileCodeIcon,
  py: FileCodeIcon,
  sh: FileCodeIcon,
}

/** Возвращает сам компонент иконки, а не строковый ключ. */
export function iconForFile(file: Pick<FileDto, "contentType" | "extension">): Component {
  const type = file.contentType?.toLowerCase() ?? ""

  if (type.startsWith("image/")) {
    return FileImageIcon
  }

  if (type.startsWith("video/")) {
    return FileVideoCameraIcon
  }

  if (type.startsWith("audio/")) {
    return FileMusicIcon
  }

  if (type === "application/pdf" || type.startsWith("text/")) {
    return FileTextIcon
  }

  return EXTENSION_ICONS[file.extension?.toLowerCase() ?? ""] ?? FileIcon
}
