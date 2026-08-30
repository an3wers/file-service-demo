import { computed, ref, shallowRef } from "vue"
import type { UploadOptions } from "@/api/client"
import type {
  FileDto,
  MultipartPartDto,
  PresignMultipartResponse,
  PresignSingleResponse,
} from "@/types/api"
import {
  completeUpload,
  deleteFile,
  fetchPartUrls,
  getMultipartStatus,
  presignUpload,
  putPart,
  putToPresignedUrl,
  uploadViaServer,
} from "@/api/files"
import { isAbortError, isApiError } from "@/api/client"
import { chunk, range, runPool } from "@/lib/parts"

export type UploadMode = "server" | "presigned"
export type UploadStage =
  | "idle"
  | "presigning"
  | "sending"
  | "processing"
  | "completing"

/** Справочная константа: настоящий лимит живёт на сервере и приходит как 413. */
export const MAX_UPLOAD_SIZE_MB = Number(
  import.meta.env.VITE_MAX_UPLOAD_SIZE_MB ?? "50",
)
export const MAX_UPLOAD_SIZE_BYTES = MAX_UPLOAD_SIZE_MB * 1024 * 1024

/**
 * Сколько раз пробуем одну часть, прежде чем признать загрузку неудачной. Между
 * попытками ссылка перевыпускается: самая частая причина отказа здесь —
 * протухшая подпись, а не сеть.
 */
const PART_ATTEMPTS = 3

const mode = ref<UploadMode>("server")
const uploading = ref(false)
const stage = ref<UploadStage>("idle")
// Глубокая реактивность на File не нужна и только мешает.
const selectedFile = shallowRef<File | null>(null)

const sentBytes = ref(0)
const totalBytes = ref(0)
// Ноль означает «файл идёт целиком»: счётчик частей показывается только у multipart.
const partsTotal = ref(0)
const partsDone = ref(0)
/** 0…100 по отправленному телу. Ответ сервера сюда не входит — см. `stage`. */
const percent = computed(() =>
  totalBytes.value > 0
    ? Math.min(100, Math.round((sentBytes.value / totalBytes.value) * 100))
    : // Пустой файл: отправлять нечего, и событий прогресса по нему не будет.
      100,
)
// Отмена имеет смысл, только пока тело не ушло целиком: после этого сервер (или
// S3) доведёт загрузку до конца независимо от нас.
const cancellable = computed(
  () =>
    uploading.value &&
    (stage.value === "presigning" || stage.value === "sending"),
)

// Не ref: контроллер нужен только императивно, реактивность на нём бесполезна.
let controller: AbortController | null = null

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Колбэки XHR: прогресс тела и переход в стадию ожидания ответа. */
function trackSending(signal: AbortSignal, next: UploadStage): UploadOptions {
  return {
    signal,
    onProgress: ({ loaded, total }) => {
      sentBytes.value = loaded

      // У multipart тело больше файла, а при неизвестном размере оставляем оценку.
      if (total !== null) {
        totalBytes.value = total
      }
    },
    // Байты ушли, но работа не закончена: дальше сервер или S3.
    onSent: () => {
      stage.value = next
    },
  }
}

/** Подтверждение загрузки с одной повторной попыткой на «S3 ещё не видно». */
async function confirmUpload(id: string): Promise<FileDto> {
  try {
    return await completeUpload(id)
  } catch (error) {
    // S3 бывает виден не мгновенно — одна повторная попытка и только потом ошибка.
    // 503 здесь про то же самое: сервер не достучался до S3 на `HeadObject`, и это
    // временный сбой, а не отказ (502 — уже отказ, его не повторяем).
    if (
      isApiError(error) &&
      (error.code === "UPLOAD_NOT_COMPLETED" || error.status === 503)
    ) {
      await delay(800)

      return await completeUpload(id)
    }

    throw error
  }
}

/** Весь файл одним PUT: сценарий, который был здесь до multipart. */
async function uploadSingle(
  file: File,
  reservation: PresignSingleResponse,
  signal: AbortSignal,
): Promise<FileDto> {
  stage.value = "sending"
  // Если этот шаг упадёт (в том числе от отмены), `complete` НЕ вызываем: запись
  // останется pending и её разберёт серверный `npm run db:cleanup` (PENDING_TTL_HOURS).
  await putToPresignedUrl(
    reservation.uploadUrl,
    file,
    reservation.requiredHeaders,
    trackSending(signal, "processing"),
  )

  stage.value = "completing"

  return await confirmUpload(reservation.id)
}

/** Сколько байт каждой части уже ушло — из этого складывается общая шкала. */
type PartProgress = (partNumber: number, loaded: number) => void

/**
 * Одна часть: PUT прямо в S3, а при неудаче — повтор со свежей ссылкой. Отмену
 * не повторяем: `AbortError` означает решение пользователя, а не сбой.
 */
async function sendPart(
  file: File,
  id: string,
  part: MultipartPartDto,
  signal: AbortSignal,
  report: PartProgress,
): Promise<void> {
  let current = part

  for (let attempt = 1; ; attempt += 1) {
    const { partNumber, offset, size, url } = current

    try {
      await putPart(url, file.slice(offset, offset + size), {
        signal,
        onProgress: ({ loaded }) => report(partNumber, loaded),
      })

      // Часть принята: досчитываем её до полного размера — событие прогресса на
      // последние байты браузер присылать не обязан.
      report(partNumber, size)
      partsDone.value += 1

      return
    } catch (error) {
      if (isAbortError(error) || attempt >= PART_ATTEMPTS) {
        throw error
      }

      // Байты неудачной попытки не долетели — иначе шкала уедет вперёд.
      report(partNumber, 0)
      await delay(attempt * 500)

      const refreshed = await fetchPartUrls(id, [partNumber], signal)

      current = refreshed.parts[0] ?? current
    }
  }
}

/**
 * Заливает указанные части, соблюдая назначенную сервером параллельность.
 *
 * Ссылки берутся пачками того же размера, какой сервер прислал в плане: у
 * `part-urls` есть предел на число номеров в запросе (`MULTIPART_URL_BATCH`), и
 * длина первой пачки — единственное, по чему клиент о нём знает. Пачка за
 * пачкой, а не все ссылки сразу: у подписи короткий срок жизни, и подписанная
 * перед самой отправкой доживает до неё гарантированно.
 */
async function uploadParts(
  file: File,
  plan: PresignMultipartResponse,
  numbers: number[],
  known: Map<number, MultipartPartDto>,
  signal: AbortSignal,
  report: PartProgress,
): Promise<void> {
  const batchSize = Math.max(1, plan.parts.length)

  for (const batch of chunk(numbers, batchSize)) {
    const parts = batch.every((partNumber) => known.has(partNumber))
      ? batch.map((partNumber) => known.get(partNumber) as MultipartPartDto)
      : (await fetchPartUrls(plan.id, batch, signal)).parts

    await runPool(parts, plan.maxConcurrency, (part) =>
      sendPart(file, plan.id, part, signal, report),
    )
  }
}

/**
 * `uploadParts` плюс уборка за сорвавшейся загрузкой. Брошенная загрузка не
 * исчезает сама: S3 берёт деньги за уже залитые части и держит занятым слот из
 * `MULTIPART_MAX_ACTIVE_UPLOADS`, пока её не отменят. `DELETE` по незавершённой
 * записи делает ровно `AbortMultipartUpload`; если и он не прошёл, остаток
 * разберёт серверный `npm run db:cleanup`.
 */
async function pumpParts(
  file: File,
  plan: PresignMultipartResponse,
  numbers: number[],
  known: Map<number, MultipartPartDto>,
  signal: AbortSignal,
  report: PartProgress,
): Promise<void> {
  try {
    await uploadParts(file, plan, numbers, known, signal, report)
  } catch (error) {
    await deleteFile(plan.id).catch(() => {})

    throw error
  }
}

/** Файл частями напрямую в S3: план целиком приходит от сервера. */
async function uploadMultipart(
  file: File,
  plan: PresignMultipartResponse,
  signal: AbortSignal,
): Promise<FileDto> {
  // Прогресс складываем вручную: события `progress` идут по каждой части
  // отдельно, а шкала в интерфейсе одна на файл.
  const loaded = new Map<number, number>()
  const report: PartProgress = (partNumber, bytes) => {
    loaded.set(partNumber, bytes)

    let total = 0

    for (const value of loaded.values()) {
      total += value
    }

    sentBytes.value = total
  }

  const known = new Map(plan.parts.map((part) => [part.partNumber, part]))

  partsTotal.value = plan.partCount
  partsDone.value = 0
  stage.value = "sending"

  await pumpParts(file, plan, range(1, plan.partCount), known, signal, report)

  stage.value = "completing"

  try {
    return await confirmUpload(plan.id)
  } catch (error) {
    if (!isApiError(error) || error.code !== "MULTIPART_INCOMPLETE") {
      // Части на месте — отменять нечего: повторный `complete` (свой или из
      // `db:cleanup`) ещё соберёт объект, а `DELETE` уничтожил бы всю работу.
      throw error
    }

    // Часть могла не долететь незаметно для нас. Источник истины по залитому —
    // сам S3, поэтому спрашиваем у него, чего не хватает, и досылаем. Ровно один
    // такой заход: если и после него не полный набор, дело не в потерянной части.
    const status = await getMultipartStatus(plan.id, signal)
    const uploaded = new Set(status.uploadedParts)
    const missing = range(1, plan.partCount).filter(
      (partNumber) => !uploaded.has(partNumber),
    )

    partsDone.value = plan.partCount - missing.length
    stage.value = "sending"
    // Пустой `known`: ссылкам из плана к этому моменту может быть больше часа.
    await pumpParts(file, plan, missing, new Map(), signal, report)

    stage.value = "completing"

    return await confirmUpload(plan.id)
  }
}

/**
 * Стратегию выбирает сервер: он один знает и лимиты хранилища, и настройки
 * бакета. Клиент присылает размер и делает то, что ему ответили.
 */
async function uploadPresigned(
  file: File,
  directory: string,
  signal: AbortSignal,
): Promise<FileDto> {
  stage.value = "presigning"

  const reservation = await presignUpload(
    {
      filename: file.name,
      directory,
      // Именно `|| undefined`: у `contentType` на сервере `min(1)`, пустая строка
      // даст 422. Если тип не определён браузером, сервер сам подставит octet-stream.
      contentType: file.type || undefined,
      // Без `size` сервер не сможет составить план и всегда ответит single.
      size: file.size,
    },
    signal,
  )

  return reservation.strategy === "multipart"
    ? await uploadMultipart(file, reservation, signal)
    : await uploadSingle(file, reservation, signal)
}

/** Директория должна быть уже нормализована через `checkDirectory`. */
async function upload(file: File, directory: string): Promise<FileDto> {
  uploading.value = true
  sentBytes.value = 0
  // Размер файла как стартовая оценка: до первого события прогресса шкала уже нужна.
  totalBytes.value = file.size
  partsTotal.value = 0
  partsDone.value = 0
  controller = new AbortController()

  const { signal } = controller

  try {
    return mode.value === "server"
      ? await uploadViaServer(
          file,
          directory,
          trackSending(signal, "processing"),
        )
      : await uploadPresigned(file, directory, signal)
  } finally {
    uploading.value = false
    stage.value = "idle"
    controller = null
  }
}

/** Прерывает отправку: вызывающий получит `AbortError` из `upload`. */
function cancel(): void {
  controller?.abort()
}

export function useUpload() {
  return {
    mode,
    uploading,
    stage,
    selectedFile,
    sentBytes,
    totalBytes,
    partsTotal,
    partsDone,
    percent,
    cancellable,
    upload,
    cancel,
  }
}
