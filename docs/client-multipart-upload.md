# Клиент: как работает multipart upload больших файлов

> Описание фактического кода на 31.08.2026. Серверная сторона — [`server-multipart-upload-plan.md`](./server-multipart-upload-plan.md)
> и [`server/README.md`](../server/README.md).

## Context

У клиента два режима загрузки, которые видит пользователь: «Через сервер» (`POST /api/files`,
FormData через API, лимит `MAX_UPLOAD_SIZE_MB`) и «Напрямую в S3» (presigned PUT мимо API).
Multipart — это не третий пункт в переключателе, а подвид режима «Напрямую в S3»: для больших
файлов сервер в ответ на presign присылает не одну ссылку, а план разбиения, и клиент заливает
файл частями параллельно прямо в S3.

**Ключевая идея: клиент не считает разбиение.** `offset`, `size`, `partCount`, `partSize`,
`maxConcurrency` присылает сервер. Клиент ведёт очередь номеров частей, режет
`file.slice(offset, offset + size)` и заливает срезы, повторяет упавшие части со свежими
ссылками и досылает потерянные.

## Карта файлов

| Файл | Роль |
|---|---|
| `src/components/UploadPanel.vue` | UI: выбор режима/файла/папки, кнопка, прогресс, тосты |
| `src/composables/useUpload.ts` | вся оркестрация загрузки (состояние + логика) |
| `src/api/files.ts` | тонкие обёртки над HTTP-эндпоинтами |
| `src/api/client.ts` | `xhrSend` (PUT тела через XHR ради прогресса), разбор ошибок |
| `src/lib/parts.ts` | чистые помощники: `range`, `chunk`, `runPool` (пул параллельности) |
| `src/types/api.ts` | типы ответов сервера (`PresignMultipartResponse`, `MultipartPartDto`, …) |

---

## Шаг 0. Выбор в UI — `UploadPanel.vue`

Пользователь выбирает режим «Напрямую в S3» (`upload.mode = "presigned"`), файл и директорию,
жмёт «Загрузить» → `submit()` (`UploadPanel.vue:171`) → `upload.upload(file, directory.value)`.

Режима `multipart` в переключателе нет — только «Через сервер» и «Напрямую в S3». Разложение на
части включает сервер по размеру файла.

## Шаг 1. Старт — `upload()` (`useUpload.ts:326`)

```
uploading = true
sentBytes = 0
totalBytes = file.size            // стартовая оценка шкалы до первого события прогресса
partsTotal = 0; partsDone = 0
controller = new AbortController() // единый signal на всю загрузку
```

Ветвление:
- `mode === "server"` → старый путь `uploadViaServer` (FormData через API);
- иначе → `uploadPresigned(file, directory, signal)`.

`finally` всегда сбрасывает `uploading`, `stage = "idle"`, `controller = null`.

## Шаг 2. Presign — сервер выбирает стратегию (`uploadPresigned`, `useUpload.ts:300`)

`stage = "presigning"`. Запрос `presignUpload({ filename, directory, contentType: file.type || undefined, size: file.size })`
→ `POST /api/files/presign-upload`.

- `size` обязателен: без него сервер не составит план и всегда ответит `single`.
- Ответ — union с дискриминатором `strategy` (`types/api.ts:102`):
  - `strategy === "multipart"` → `uploadMultipart(file, reservation, signal)`;
  - иначе (в т.ч. ответ старого сервера без поля) → `uploadSingle`.

Что приходит в `PresignMultipartResponse` (`types/api.ts:76`):

| Поле | Смысл |
|---|---|
| `id` | id записи в БД (создана в статусе `pending`) |
| `uploadId` | id S3 multipart upload |
| `size`, `partSize`, `partCount` | план разбиения (посчитан сервером) |
| `maxConcurrency` | сколько частей держать в полёте одновременно — назначает сервер |
| `parts` | **первая пачка** ссылок: `min(partCount, MULTIPART_URL_BATCH)` штук |
| `expiresAt` | общий срок жизни пачки ссылок |

Каждый `MultipartPartDto`: `{ partNumber, offset, size, url }`, где `url` — presigned-PUT прямо в S3.

## Шаг 3. Подготовка multipart — `uploadMultipart` (`useUpload.ts:237`)

1. Заводится `loaded = Map<partNumber, bytes>` и функция `report(partNumber, bytes)`: пишет в map
   и **суммирует все значения → `sentBytes`**. События `progress` приходят по каждой части
   отдельно, а шкала в UI одна на файл.
2. `known = Map(partNumber → dto)` из уже присланных в плане частей.
3. `partsTotal = plan.partCount`, `partsDone = 0`, `stage = "sending"`.
4. `pumpParts(file, plan, range(1, partCount), known, signal, report)` — залить номера 1…`partCount`.
5. После заливки: `stage = "completing"` → `confirmUpload(plan.id)` (шаг 7).

## Шаг 4. Очередь и пачки ссылок — `uploadParts` (`useUpload.ts:191`)

```
batchSize = Math.max(1, plan.parts.length)      // длина ПЕРВОЙ пачки из плана
for (const batch of chunk(numbers, batchSize)) {
  const parts = все номера batch есть в known
      ? взять из known
      : (await fetchPartUrls(plan.id, batch, signal)).parts   // POST /files/:id/multipart/part-urls
  await runPool(parts, plan.maxConcurrency, part => sendPart(...))
}
```

- **Почему пачками, а не все ссылки сразу**: у presigned-подписи короткий TTL
  (`PRESIGN_PART_TTL_SECONDS`); ссылка, подписанная непосредственно перед отправкой,
  гарантированно доживёт до неё.
- **Почему `batchSize` = длина первой пачки**: у эндпоинта `part-urls` серверный лимит
  `MULTIPART_URL_BATCH` на число номеров в одном запросе. Длина `plan.parts` — единственное, по
  чему клиент об этом лимите знает.
- `pumpParts` (`useUpload.ts:219`) — это `uploadParts` + уборка: при любой ошибке заливки делает
  `deleteFile(plan.id)` (на сервере → `AbortMultipartUpload`, освобождает слот и деньги в S3) и
  пробрасывает ошибку дальше.

## Шаг 5. Пул параллельности — `runPool` (`parts.ts:40`)

- Одна общая очередь `queue = [...items]`.
- Запускается `width = min(maxConcurrency, items.length)` воркеров; каждый в цикле `queue.shift()`
  берёт часть и `await worker(part)`.
- Первая ошибка ставит `stopped = true` — новые части из очереди не берутся, но **уже летящие
  дожидаются** (`Promise.allSettled`, а не `Promise.all` — иначе `unhandledrejection` на каждый
  недобитый промис).
- После — первая пойманная ошибка пробрасывается наружу.

## Шаг 6. Отправка одной части — `sendPart` (`useUpload.ts:142`)

Цикл попыток, до `PART_ATTEMPTS = 3`:

1. `putPart(url, file.slice(offset, offset + size), { signal, onProgress })` → `putToS3` →
   `xhrSend("PUT", url, blob)` **без единого заголовка**:
   - сервер подписал часть «голой» (`Bucket`, `Key`, `UploadId`, `PartNumber`);
   - `file.slice()` возвращает Blob с пустым `type`, поэтому браузер не подставит `Content-Type` —
     подпись сходится;
   - идёт на чужой origin (S3), поэтому без `X-API-Key` и без credentials (`files.ts:83`).
2. `onProgress` → `report(partNumber, loaded)`.
3. **Успех**: `report(partNumber, size)` — досчитываем часть до полного размера (событие на
   последние байты браузер слать не обязан), `partsDone += 1`, выход.
4. **Ошибка**:
   - `AbortError` (пользователь отменил) или попытки исчерпаны → пробросить;
   - иначе: `report(partNumber, 0)` — откатываем шкалу, байты неудачной попытки не долетели;
     `delay(attempt * 500)`; `fetchPartUrls(id, [partNumber])` за **свежей ссылкой** (самая частая
     причина отказа здесь — протухшая подпись, а не сеть); повтор.

## Шаг 7. Подтверждение — `confirmUpload` (`useUpload.ts:94`)

`completeUpload(id)` → `POST /api/files/:id/complete`. Сервер делает `CompleteMultipartUpload`,
переводит запись в `ready`, возвращает `FileDto`.

Один авто-ретрай через 800 мс, если код `UPLOAD_NOT_COMPLETED` или статус `503` — S3 после записи
виден не мгновенно (сервер не достучался на `HeadObject`). `502` — это уже отказ, его не повторяем.

## Шаг 8. Досылка потерянных частей (`useUpload.ts:269`)

Если `confirmUpload` бросил `ApiError` с кодом `MULTIPART_INCOMPLETE` — часть могла не долететь
незаметно для клиента:

1. Источник истины по залитому — сам S3: `getMultipartStatus(plan.id)` →
   `GET /api/files/:id/multipart` (ответ строится по `ListParts`), даёт `uploadedParts`.
2. `missing = range(1, partCount).filter(n => !uploaded.has(n))`.
3. `partsDone = partCount - missing.length`, `stage = "sending"`.
4. `pumpParts(file, plan, missing, new Map(), …)` — **пустой `known`**: ссылкам из исходного плана
   к этому моменту может быть больше часа, все берём заново.
5. Ещё один `confirmUpload`. Заход ровно один — если и после него набор неполный, дело не в
   потерянной части.

Если код был **не** `MULTIPART_INCOMPLETE` — ошибка пробрасывается **без** `DELETE`: части лежат в
S3, повторный `complete` (свой или серверный `db:cleanup`) ещё соберёт объект, а `DELETE`
уничтожил бы всю работу.

## Шаг 9. Прогресс и стадии в UI

- `stage`: `idle → presigning → sending → completing` (`processing` — только у single/server).
- `percent` (`useUpload.ts:55`) = `round(sentBytes / totalBytes * 100)`. У multipart `sentBytes` —
  сумма по `report`, `totalBytes` остаётся `file.size`.
- `partsTotal` / `partsDone` — счётчик частей; в `UploadPanel.vue:141` показывается
  `часть N из M`, только когда `partsTotal > 0` (т.е. только у multipart).
- `indeterminate` (`UploadPanel.vue:136`) — шкала «пульсирует» на всех стадиях кроме `sending`.
- `cancellable` (`useUpload.ts:63`) — кнопка «Отменить» активна только на `presigning`/`sending`;
  после того как тело ушло, отмена смысла не имеет.

## Шаг 10. Отмена и уборка мусора

**Отмена** (`cancel()` → `controller.abort()`):
- все летящие `putPart` (XHR) и `fetchPartUrls` (fetch) слушают `signal` → падают с `AbortError`;
- `runPool` перестаёт разбирать очередь; `sendPart` `AbortError` не ретраит;
- `pumpParts` ловит ошибку → `deleteFile(plan.id)` (сервер → `AbortMultipartUpload`) →
  пробрасывает `AbortError`;
- `UploadPanel.submit` (`UploadPanel.vue:198`) ловит `isAbortError` → тост «Загрузка отменена»,
  файл и диалог оставляет как есть.

**Почему уборка важна**: брошенная multipart-загрузка не исчезает сама — S3 берёт деньги за уже
залитые части и держит занятым слот из `MULTIPART_MAX_ACTIVE_UPLOADS`. Поэтому:
- любой сбой заливки частей → `deleteFile` = `AbortMultipartUpload`;
- если и `DELETE` не прошёл — остаток подберёт серверный `npm run db:cleanup` (по TTL);
- если упало ещё до `complete` и `DELETE` не было — запись остаётся `pending`, её тоже разбирает
  `db:cleanup` (`PENDING_TTL_HOURS`).

Ошибки, обработанные в `UploadPanel.submit` особым образом: `TOO_MANY_ACTIVE_UPLOADS` (429 — заняты
слоты, без кнопки «Повторить»), `S3_UPLOAD_FAILED` (подсказка про CORS бакета и порт 5173),
`PAYLOAD_TOO_LARGE`.

---

## HTTP-эндпоинты, задействованные в multipart

| Метод | Путь | Когда |
|---|---|---|
| `POST` | `/api/files/presign-upload` | получить план (`strategy`, `partCount`, `maxConcurrency`, первая пачка ссылок) |
| `POST` | `/api/files/:id/multipart/part-urls` | следующая пачка ссылок / замена протухшей |
| `PUT` | `<s3-url>` (чужой origin) | тело одной части, без заголовков и без API-ключа |
| `GET` | `/api/files/:id/multipart` | что реально долетело (по `ListParts`) — для досылки |
| `POST` | `/api/files/:id/complete` | `CompleteMultipartUpload`, запись → `ready` |
| `DELETE` | `/api/files/:id` | `AbortMultipartUpload` при сбое/отмене |
