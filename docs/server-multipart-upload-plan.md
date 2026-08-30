> **Статус: реализовано 30.08.2026.** План выполнен целиком; ниже — исходный документ без изменений.
> Отличия итогового кода от плана:
>
> - `part-urls` с номером части `0` отбивается zod-схемой как `422 VALIDATION_ERROR`, а не
>   `400 INVALID_PART_NUMBER`, как обещает таблица в «Проверке». Нижняя граница — это форма запроса, и
>   ей место на границе валидации; в сервисе остаётся верхняя, которой нужен `part_count` из записи.
> - `PENDING_TTL_HOURS` пришлось смягчить с `positive()` до `nonnegative()`: раздел «Проверка»
>   предписывает `PENDING_TTL_HOURS=0`, а такое значение не проходило валидацию конфига. Ноль теперь
>   штатно значит «разобрать всё висящее прямо сейчас».
> - `listAllParts` типизирован SDK-типом `Part`, а не `CompletedPart`: поле `Size`, из которого
>   считается `uploadedBytes`, есть только в первом.
>
> Актуальный контракт — [`server/README.md`](../server/README.md).

---

# Сервер: загрузка больших файлов через multipart upload

## Context

Сегодня у сервиса два сценария загрузки, и оба упираются в потолок на больших файлах.

1. **Через сервер** (`POST /api/files`, multer + `memoryStorage`) — файл целиком буферизуется в
   памяти процесса, поэтому `MAX_UPLOAD_SIZE_MB` (по умолчанию 50) там несущий, а не косметический
   лимит. Всё, что больше, отбивается как `413 PAYLOAD_TOO_LARGE`.
2. **Presigned PUT напрямую в S3** (`POST /api/files/presign-upload` → `PUT <uploadUrl>` →
   `POST /api/files/:id/complete`) — байты не проходят через API, и формального лимита нет. Но это
   один HTTP-запрос на весь файл: он не возобновляется, не параллелится, а `PutObject` в S3 в
   принципе ограничен 5 ГиБ. Разрыв сети на 4.9 ГиБ из 5 означает загрузку с нуля.

Нужен третий сценарий: **S3 multipart upload с presigned-ссылками на каждую часть**. Файл режется на
части, каждая заливается отдельным `PUT` прямо в S3, упавшую часть можно повторить, а прерванную
загрузку — продолжить. Байты по-прежнему не идут через процесс API.

**Ключевое требование: решение о том, на сколько частей резать файл, принимает сервер.** Клиент не
знает ни лимитов S3, ни настроек бакета; он присылает размер и получает готовый план — размер части,
их количество и смещения. Логика разбиения живёт в одном месте, покрыта юнит-тестами и меняется через
`.env`, а не правкой клиента.

Объём этого плана — **только `server/`**. Что понадобится сделать на клиенте, описано в конце как
контракт, но в задачи не входит.

---

## Что уже есть и переиспользуется

| Актив | Путь | Как используем |
|---|---|---|
| `buildObjectKey`, `normalizeDirectory`, `sanitizeFileName` | `src/s3/keys.ts` | ключ и директория строятся ровно так же, как в single-сценарии |
| `storageError`, `isS3NotFound` | `src/s3/errors.ts` | все вызовы S3 оборачиваются в них; рядом добавится `isS3NoSuchUpload` |
| `s3`, `bucket` | `src/s3/client.ts` | `requestChecksumCalculation: "WHEN_REQUIRED"` уже стоит — без него подпись части сломается ровно так же, как ломалась single-PUT |
| `AppError` + фабрики `badRequest/conflict/payloadTooLarge` | `src/errors.ts` | новые коды добавляются в тот же `ERROR_CODES` |
| `validateBody/validateParams`, `validatedParams` | `src/middleware/validate.ts` | новые маршруты валидируются тем же способом |
| `insertFile`, `findFileById`, `markFileReady`, `markFileFailed`, `softDeleteFile`, `listExpiredPending` | `src/modules/files/files.repo.ts` | расширяются, а не дублируются |
| `toFileDto` | `src/modules/files/files.mapper.ts` | ответ `complete` остаётся обычным `FileDto` |
| Раннер миграций | `src/db/migrate.ts` | новая миграция — просто файл `002_*.sql` |
| `cleanup-pending.ts` | `src/scripts/` | тот же скрипт разбирает и брошенные multipart-загрузки |
| Бакетный CORS | `src/scripts/s3-cors.ts` | **менять не нужно**, см. ниже |
| `@aws-sdk/client-s3@3.1119.0` | `package.json` | все команды multipart уже в пакете |

Ничего из этого не пересоздаём. **Новых npm-зависимостей план не добавляет** — `@aws-sdk/lib-storage`
не нужен: он грузит из Node, а нам нужны подписанные ссылки для браузера.

**Бакетный CORS переигрывать не надо.** Части уходят обычным `PUT`, а он уже в `AllowedMethods`.
`CreateMultipartUpload`, `ListParts`, `Complete` и `Abort` выполняет сервер своими ключами, из
браузера они не вызываются, поэтому ни `POST`, ни `DELETE` в правило добавлять не нужно.

---

## Ограничения S3, которые определяют логику

Это жёсткие лимиты протокола, а не наши настройки; они не конфигурируются и живут в коде константами.

| Лимит | Значение | Следствие |
|---|---|---|
| Минимальный размер части | 5 МиБ | **кроме последней** — она может быть любой, вплоть до 1 байта |
| Максимальный размер части | 5 ГиБ | |
| Максимум частей | 10 000 | при фиксированном `partSize` это и есть потолок размера файла |
| Максимальный размер объекта | 5 ТиБ | |
| Страница `ListParts` | 1 000 частей | обязательна пагинация по `PartNumberMarker` |

Отдельно: **за части незавершённой multipart-загрузки S3 берёт деньги**, пока её не завершили или не
отменили. Поэтому откат при сбое (`Abort`) и уборка брошенных загрузок — не гигиена, а часть
функциональности; им посвящён блок C.

---

## Как сервер решает, на сколько частей резать

Вся арифметика — в одном чистом модуле `src/s3/multipart.ts`: без обращений к S3 и БД, по образцу
`src/s3/keys.ts`, и с юнит-тестами рядом.

```ts
/** Жёсткие лимиты протокола S3. Не конфигурируются. */
export const S3_LIMITS = {
  minPartSize: 5 * 1024 * 1024,           // 5 МиБ, все части кроме последней
  maxPartSize: 5 * 1024 * 1024 * 1024,    // 5 ГиБ
  maxParts: 10_000,
  maxObjectSize: 5 * 1024 ** 4,           // 5 ТиБ
} as const;

export interface PlanLimits {
  partSize: number;      // желаемый размер части (config.uploads.multipartPartSizeBytes)
  maxParts: number;      // config.uploads.multipartMaxParts, не больше S3_LIMITS.maxParts
  maxObjectSize: number; // config.uploads.maxObjectSizeBytes, не больше S3_LIMITS.maxObjectSize
}

export interface UploadPlan {
  size: number;
  partSize: number;
  partCount: number;
  lastPartSize: number;
}

/** Границы одной части — то, что клиент подставит в `file.slice(offset, offset + size)`. */
export function partRange(plan: UploadPlan, partNumber: number): { offset: number; size: number };

export function planMultipart(size: number, limits?: PlanLimits): UploadPlan;
```

`limits` необязателен и по умолчанию берётся из `config`. Параметр существует ради тестов: краевые
случаи (`maxParts: 3`) проверяются передачей аргумента, а не подменой окружения.

**Алгоритм `planMultipart`:**

1. `size <= 0` → `badRequest(INVALID_UPLOAD_SIZE)`. Резать нечего.
2. `size > limits.maxObjectSize` → `payloadTooLarge`. Проверка идёт первой: дальше считать бессмысленно.
3. `partSize = limits.partSize` — желаемый размер из конфига, уже провалидированный как ≥ 5 МиБ.
4. Если `ceil(size / partSize) > limits.maxParts`, часть надо увеличить:
   `partSize = ceilTo(ceil(size / limits.maxParts), 1 МиБ)`. Округление **вверх до мегабайта**, а не
   точное деление, — так `partCount` гарантированно укладывается в лимит и не зависит от ошибки
   округления в последнем байте.
5. `partSize` зажимается в `[S3_LIMITS.minPartSize, S3_LIMITS.maxPartSize]`.
6. `partCount = ceil(size / partSize)`. Если он всё ещё больше `maxParts` → `payloadTooLarge`. При
   `maxObjectSize ≤ 5 ТиБ` эта ветка недостижима (10 000 × 5 ГиБ = 50 ТиБ), но остаётся страховкой на
   случай, если потолок в конфиге когда-нибудь поднимут.
7. `lastPartSize = size - (partCount - 1) * partSize`.

**Последняя часть почти всегда меньше 5 МиБ, и это нормально** — правило минимума на неё не
распространяется. Выглядит как баг, поэтому в коде это отмечено комментарием, а в тестах — отдельным
кейсом.

Что получается при значениях по умолчанию (`partSize` 16 МиБ, `maxParts` 10 000):

| Размер файла | Стратегия | `partSize` | `partCount` | Последняя часть |
|---|---|---|---|---|
| 80 МиБ | `single` | — | — | ниже порога в 100 МиБ |
| 100 МиБ | `multipart` | 16 МиБ | 7 | 4 МиБ |
| 1 ГиБ | `multipart` | 16 МиБ | 64 | 16 МиБ |
| 10 ГиБ | `multipart` | 16 МиБ | 640 | 16 МиБ |
| 160 ГиБ | `multipart` | **17 МиБ** | 9 638 | ~15.7 МиБ |
| 201 ГиБ | — | — | — | `413 PAYLOAD_TOO_LARGE` |

Строка на 160 ГиБ — это и есть срабатывание шага 4: при 16 МиБ вышло бы 10 240 частей, что за
лимитом, поэтому часть подросла до 17 МиБ и их стало 9 638. Строка на 201 ГиБ — шаг 2 при
`MAX_OBJECT_SIZE_GB=200`.

**Порог включения multipart** — отдельная функция там же:

```ts
export function needsMultipart(size: number | undefined, threshold: number): boolean {
  return size !== undefined && size >= threshold;
}
```

`size` в `presignUploadSchema` необязателен и остаётся таковым: **если размера нет, сценарий
single** — ровно как сегодня. Это единственное, что сохраняет обратную совместимость для вызовов без
`size`.

---

## Сколько частей грузить одновременно

Параллельность — вторая половина того же решения, что и разбиение. Клиент не знает ни ширины канала до
S3, ни того, сколько загрузок сервис ведёт прямо сейчас, поэтому **число одновременно летящих частей
тоже назначает сервер** и присылает его в плане полем `maxConcurrency`. Своей константы у клиента быть
не должно: иначе потолок придётся менять релизом фронтенда.

**Почему по умолчанию 4.** Браузер сам держит не больше ~6 одновременных соединений на origin, а все
части уходят на один и тот же хост S3 — седьмой параллельный `PUT` не поедет быстрее шестого, он
просто встанет в очередь и съест свой таймаут. Четыре оставляют запас на остальные запросы страницы
(вызовы API, `download-url`, иконки). Значение вынесено в конфиг именно потому, что оптимум зависит от
канала и от того, отвечает ли эндпоинт по HTTP/2, где лимита на соединения нет.

Второе следствие, которое видно только с сервера: `maxConcurrency × partSize` — это ещё и пик памяти
во вкладке. При выросшей до 17 МиБ части и восьми параллельных загрузках вкладка держит 136 МиБ, и
дальше браузер начинает отбирать память у самого приложения. Поэтому число частей и их размер
назначаются в одном месте и одним решением.

**Что сервер охраняет у себя.** Параллельность клиента — не единственная конкуренция в этой
функциональности:

1. **Одновременно открытых multipart-загрузок не больше `MULTIPART_MAX_ACTIVE_UPLOADS`.** Каждая
   незакрытая загрузка держит в бакете залитые части, за которые идёт счёт (см. блок C). Без потолка
   скрипт в цикле откроет их тысячу, и счёт придёт сильно раньше, чем сработает суточный
   `PENDING_TTL_HOURS`. Проверка — задача B6.
2. **Подписывание пачки — это CPU, а не сеть.** `getSignedUrl` считает HMAC-SHA256 и никуда не ходит:
   сокет он не занимает, но `Promise.all` на сотню ссылок блокирует событийный цикл на всю пачку
   разом. Значит `MULTIPART_URL_BATCH` — ручка не только размера ответа, но и отзывчивости процесса, и
   это вторая причина не отдавать 10 000 ссылок одним куском.
3. **Свои запросы к S3 идут через общий пул сокетов.** `requestHandler` в `src/s3/client.ts` не задаёт
   `maxSockets`, то есть действует умолчание SDK — 50 на хост. Пагинация `ListParts` расходует пул
   последовательно, по одному запросу на загрузку, так что 50 хватает с запасом; но если завершений
   станет много одновременно, поднимать надо именно там, а не в настройках multipart.
4. **Гонки на завершении и на уборке.** Два параллельных `complete` по одной записи и уборщик,
   налетевший на живую загрузку, — задачи B4 и C1; оба разрешаются без блокировок.

| Ручка | По умолчанию | Что ограничивает |
|---|---|---|
| `MULTIPART_MAX_CONCURRENCY` | 4 | частей в полёте у одного клиента; уезжает в ответ как `maxConcurrency` |
| `MULTIPART_URL_BATCH` | 100 | ссылок за запрос: размер ответа и длина CPU-всплеска на подписи |
| `MULTIPART_MAX_ACTIVE_UPLOADS` | 10 | незакрытых multipart-загрузок во всём сервисе |

Последняя строка — **лимит на сервис целиком, а не на пользователя**: пользователей в сервисе нет,
аутентификация — один статический `API_KEY` на всех. Когда появятся учётные записи, счётчик станет
`where owner_id = $1`, и это единственное, что в нём поменяется.

---

## A. Фундамент

Без этого блока ни один эндпоинт не заводится.

### A1. Настройки multipart

**Файл:** `src/config.ts`

Дописать в `envSchema` (все — с дефолтами, поэтому `.env` можно не трогать):

```
MULTIPART_THRESHOLD_MB=100       # от какого размера уходим в multipart
MULTIPART_PART_SIZE_MB=16        # желаемый размер части
MULTIPART_MAX_PARTS=10000        # не больше 10000
MULTIPART_URL_BATCH=100          # сколько ссылок отдаём за один запрос
MULTIPART_MAX_CONCURRENCY=4      # частей в полёте у одного клиента
MULTIPART_MAX_ACTIVE_UPLOADS=10  # незакрытых загрузок во всём сервисе
PRESIGN_PART_TTL_SECONDS=3600    # TTL ссылки на часть
MAX_OBJECT_SIZE_GB=200           # потолок размера файла
```

zod-ограничения обязательны, иначе неверный конфиг превратится в ошибку S3 на первой же загрузке:
`MULTIPART_PART_SIZE_MB` — `min(5)`, `MULTIPART_THRESHOLD_MB` — `min(5)`, `MULTIPART_MAX_PARTS` —
`max(10000)`, `MAX_OBJECT_SIZE_GB` — `max(5120)` (5 ТиБ).

`MULTIPART_MAX_CONCURRENCY` — `min(1).max(16)`. Верхняя граница не техническая, а предупредительная:
всё, что выше, упирается в лимит соединений браузера и только раздувает пик памяти во вкладке.

В `config.uploads` добавить посчитанные в байтах `multipartThresholdBytes`, `multipartPartSizeBytes`,
`maxObjectSizeBytes`, а также `multipartMaxParts`, `multipartUrlBatch`, `presignPartTtlSeconds`.

**`vitest.config.ts` править не нужно** — у всех новых переменных есть значения по умолчанию. Это
единственное, что спасает: `config.ts` валидирует окружение прямо на импорте и завершает процесс,
поэтому переменная без дефолта уронила бы весь прогон тестов.

**Готово, когда:** `npm test` проходит без правки `vitest.config.ts`, а запуск с
`MULTIPART_PART_SIZE_MB=1` падает на старте с внятным сообщением.

---

### A2. Миграция под состояние multipart

**Файл:** `src/db/migrations/002_multipart.sql` (новый)

```sql
alter table files add column if not exists upload_id  text;
alter table files add column if not exists part_size  bigint;
alter table files add column if not exists part_count integer;

alter table files drop constraint if exists files_source_check;
alter table files add  constraint files_source_check
  check (upload_source in ('server', 'presigned', 'multipart'));

create index if not exists files_upload_id_idx
  on files (upload_id) where upload_id is not null;
```

Отдельной таблицы частей нет и не будет: **источник истины по залитым частям — сам S3**
(`ListParts`), а не наша база. Это то же решение, что уже принято в `completeUpload`, где `size` и
`etag` вычитываются из `HeadObject`, а не берутся на веру у клиента. Побочная выгода — возобновление
загрузки работает и после перезапуска браузера, и с другого устройства, без единой лишней строки в БД.

Индекс частичный: `upload_id` заполнен только у незавершённых multipart-записей, а после `complete`
обнуляется (A3 ниже), поэтому индекс остаётся размером с очередь активных загрузок, а не с таблицей.

**Файлы:** `src/modules/files/files.types.ts` — в `FileRow` добавить `upload_id: string | null`,
`part_size: number | null`, `part_count: number | null`; в `UploadSource` — `"multipart"`; в
`InsertFileInput` — необязательные `uploadId`, `partSize`, `partCount`.

`bigint` (OID 20) уже парсится в `number` глобальным `types.setTypeParser` в `src/db/pool.ts` —
дополнительной обработки `part_size` не требуется.

**Готово, когда:** `npm run db:migrate` применяет миграцию, повторный запуск ничего не делает, а
`insert … upload_source = 'multipart'` не отбивается констрейнтом.

---

### A3. Репозиторий

**Файл:** `src/modules/files/files.repo.ts`

- `insertFile` — дописать `upload_id`, `part_size`, `part_count` в список колонок и `values`.
- `markFileReady` — дополнительно `upload_id = null, part_size = null, part_count = null`. После
  завершения `uploadId` мёртв: S3 его больше не примет, а обнуление делает проверку «эта запись —
  незакрытая multipart-загрузка?» одним условием `upload_id is not null`.
- `markFileFailed` — оставить как есть. Обнулением `upload_id` занимается `claimExpiredMultipart`
  (C1), который возвращает старое значение тем же запросом, которым его стирает.
- Новый `listExpiredMultipart(ttlHours)` не нужен: `listExpiredPending` уже возвращает нужные строки,
  а `upload_id` теперь есть прямо в них.
- Новый `countActiveMultipart()` для потолка одновременных загрузок (B6):

  ```sql
  select count(*)::int as count
    from files
   where status = 'pending' and upload_id is not null and deleted_at is null
  ```

  Частичный индекс `files_upload_id_idx` из A2 покрывает этот запрос целиком: он построен ровно по
  `upload_id is not null`, поэтому счётчик читает индекс размером с очередь активных загрузок, а не
  сканирует таблицу.
- Новый `claimExpiredMultipart(id, ttlHours)` — атомарный захват брошенной загрузки, см. C1.

**Готово, когда:** `npm run typecheck` чист, `insertFile` пишет три новые колонки, а
`countActiveMultipart` на пустой таблице возвращает `0`, а не `null`.

---

### A4. Коды ошибок и распознавание `NoSuchUpload`

**Файл:** `src/errors.ts` — дописать в `ERROR_CODES`:

| Код | Статус | Когда |
|---|---|---|
| `INVALID_UPLOAD_SIZE` | 400 | `size <= 0` или не число |
| `INVALID_PART_NUMBER` | 400 | номер части вне `1..partCount` или пачка больше `MULTIPART_URL_BATCH` |
| `MULTIPART_NOT_FOUND` | 409 | у записи нет `upload_id`, либо S3 отвечает `NoSuchUpload` |
| `MULTIPART_INCOMPLETE` | 409 | при завершении в S3 лежат не все части |
| `TOO_MANY_ACTIVE_UPLOADS` | 429 | исчерпан `MULTIPART_MAX_ACTIVE_UPLOADS` |

Потолок размера отдаётся существующим `PAYLOAD_TOO_LARGE` (413) — новый код там не нужен, у клиента
для него уже есть текст.

Под 429 в `src/errors.ts` пока нет фабрики — добавить рядом с `payloadTooLarge`, в том же виде:

```ts
/** Лимит не превышен навсегда: освободится место — тот же запрос пройдёт. */
export const tooManyRequests = (
  code: ErrorCode,
  message: string,
  details?: unknown,
  options?: AppErrorOptions,
) => new AppError(429, code, message, details, options);
```

**Файл:** `src/s3/errors.ts` — добавить рядом с `isS3NotFound`:

```ts
/** Загрузки с таким uploadId нет: её уже завершили, уже отменили — или не было. */
export function isS3NoSuchUpload(error: unknown): boolean;
```

SDK версии 3.1119 **не экспортирует класс `NoSuchUpload`** (в `models_0.d.ts` он только упомянут в
документации), поэтому распознавание идёт по `error.name === "NoSuchUpload"` и по статусу 404 —
ровно тем же приёмом, каким `isS3NotFound` уже обходит S3-совместимые реализации.

**Готово, когда:** в `src/s3/errors.test.ts` есть кейсы на `isS3NoSuchUpload` (по имени и по голому
404), `npm test` зелёный.

---

### A5. Планировщик частей

**Файлы:** `src/s3/multipart.ts` (новый), `src/s3/multipart.test.ts` (новый)

Реализовать `S3_LIMITS`, `planMultipart`, `partRange`, `needsMultipart` по разделу «Как сервер решает,
на сколько частей резать». Модуль чистый: ни `s3.send`, ни `query`, только арифметика и `AppError`.

Тесты (тот же стиль, что `src/s3/keys.test.ts`, включая хелпер `thrownBy` для проверки кода ошибки):

- размер ровно на пороге и на байт ниже;
- размер, кратный `partSize` (последняя часть полная) и не кратный (последняя короче);
- **последняя часть меньше 5 МиБ — это валидный план, а не ошибка**;
- рост `partSize`, когда частей выходит больше `maxParts` (передаём `limits` с `maxParts: 3`);
- `partCount` никогда не превышает `maxParts`, а `partSize` не опускается ниже 5 МиБ;
- `size` больше `maxObjectSize` → `PAYLOAD_TOO_LARGE`; `size <= 0` → `INVALID_UPLOAD_SIZE`;
- `partRange` для первой, средней и последней части даёт непрерывные, не пересекающиеся отрезки,
  сумма которых равна `size`.

**Готово, когда:** `npm test` зелёный, и таблица примеров из этого документа воспроизводится тестом.

---

## B. Сценарий загрузки

Порядок вызовов, к которому идём:

```
POST /api/files/presign-upload      { filename, directory?, contentType?, size }
→ 201 { strategy: "multipart", id, uploadId, partSize, partCount, maxConcurrency,
        expiresAt, parts: [ …первые 100 ] }

PUT <parts[i].url>                  тело = file.slice(offset, offset + size)
                                    не больше maxConcurrency запросов одновременно

POST /api/files/:id/multipart/part-urls   { partNumbers: [101, …] }   ← следующая пачка / протухшие
GET  /api/files/:id/multipart                                          ← что уже залито (возобновление)

POST /api/files/:id/complete
→ 200 FileDto

DELETE /api/files/:id                                                  ← отмена
```

Новых маршрута всего два. `complete` и `delete` — существующие, они ветвятся внутри. Это осознанно:
клиенту не приходится помнить, каким способом грузился файл, чтобы его завершить или отменить.

`maxConcurrency` — не рекомендация, а часть плана: сервер отвечает за то, чтобы разбиение и
параллельность были согласованы между собой (см. «Сколько частей грузить одновременно»).

### B1. `presign-upload` сам выбирает стратегию

**Файлы:** `src/modules/files/files.service.ts`, `src/modules/files/multipart.service.ts` (новый),
`src/modules/files/files.schemas.ts`

`createPresignedUpload` начинается с `needsMultipart(body.size, config.uploads.multipartThresholdBytes)`
и при `true` делегирует в `multipart.service.ts`. Ответы различаются полем-дискриминатором `strategy`:

```jsonc
// strategy: "single" — сегодняшний ответ плюс одно новое поле
{ "strategy": "single", "id": "…", "key": "…", "directory": "docs",
  "uploadUrl": "…", "expiresAt": "…", "requiredHeaders": { "Content-Type": "…" } }

// strategy: "multipart"
{ "strategy": "multipart",
  "id": "…", "key": "docs/a5e1ee53-….bin", "directory": "docs",
  "uploadId": "2~aBcD…",
  "size": 1073741824, "partSize": 16777216, "partCount": 64,
  "maxConcurrency": 4,                       // сколько частей клиенту слать одновременно
  "expiresAt": "2026-08-30T13:00:00.000Z",   // общий TTL всей пачки ссылок
  "parts": [ { "partNumber": 1, "offset": 0, "size": 16777216, "url": "https://s3.cloud.ru/…" }, … ] }
```

`offset` и `size` в каждой части — не украшение: клиент подставляет их прямо в
`file.slice(offset, offset + size)`, и нарезка ни в одной точке не считается повторно.

**Порядок операций в `createMultipartUpload` — и почему именно такой:**

1. `normalizeDirectory` → `sanitizeFileName` → `buildObjectKey` — как в single-сценарии, без копипасты.
2. `planMultipart(size)` — может бросить 413 **до** любых побочных эффектов.
3. `countActiveMultipart()` против `MULTIPART_MAX_ACTIVE_UPLOADS` (B6) — отказ тоже должен случиться
   до того, как в бакете появится загрузка, которую придётся откатывать.
4. `CreateMultipartUploadCommand({ Bucket, Key, ContentType })` → `uploadId`.
5. Подписать первую пачку (`Promise.all` по `min(partCount, MULTIPART_URL_BATCH)` ссылкам).
6. `repo.insertFile({ …, uploadId, partSize, partCount, sizeBytes: size, status: "pending", uploadSource: "multipart" })`.

Обратите внимание на **смену порядка относительно single-сценария**. Там подпись идёт до `insert`,
потому что подписывание не имеет побочных эффектов и сбой не оставляет `pending`-записи. Здесь же
шаг 4 **создаёт объект в S3**, поэтому на провал `insertFile` нужен откат — `AbortMultipartUpload` в
`catch`, по образцу отката `DeleteObject` в `uploadThroughServer`. Без него в бакете останется
открытая загрузка, за части которой идёт счёт, и найти её будет уже нечем: `uploadId` нигде не записан.

**Подписывать часть надо голой.** В `UploadPartCommand` только `Bucket`, `Key`, `UploadId`,
`PartNumber` — ни `ContentType`, ни `ContentLength`, ни `ChecksumAlgorithm`. Content-Type объекта
фиксируется один раз на шаге 3; всё, что попало в подпись, браузеру пришлось бы воспроизвести
байт-в-байт. Заголовки `x-amz-checksum-*` уже отключены на клиенте S3
(`requestChecksumCalculation: "WHEN_REQUIRED"` в `src/s3/client.ts`) — это ровно та грабля, на которой
однажды сломался single-PUT, и здесь она сработала бы так же.

**Готово, когда:** запрос с `size: 1073741824` возвращает `strategy: "multipart"`, 64 в `partCount` и
`maxConcurrency` из конфига; запрос без `size` — прежний `strategy: "single"` со всеми старыми полями
на месте.

---

### B2. Пачка ссылок на части

**Файлы:** `src/modules/files/files.routes.ts`, `multipart.service.ts`, `files.schemas.ts`

```
POST /api/files/:id/multipart/part-urls   { "partNumbers": [101, 102, …] }
→ 200 { "expiresAt": "…", "parts": [ { partNumber, offset, size, url }, … ] }
```

Схема — `z.array(z.number().int().positive()).min(1).max(config.uploads.multipartUrlBatch)`; номера
дедуплицируются, а диапазон `1..part_count` проверяется уже в сервисе, потому что для этого нужна
строка из БД → `badRequest(INVALID_PART_NUMBER)`.

Проверки перед подписью: запись существует, `status === "pending"`, `upload_id is not null` — иначе
`conflict(MULTIPART_NOT_FOUND)`.

Этот же эндпоинт — механизм **перевыпуска протухших ссылок**. Отсюда и решение отдавать ссылки
пачками, а не все сразу: на 10 000 частей ответ вырос бы до нескольких мегабайт, а загрузка длиннее
`PRESIGN_PART_TTL_SECONDS` протухла бы целиком и разом, без возможности догрузить остаток.

**Готово, когда:** повторный запрос тех же номеров выдаёт свежие ссылки, номер `0` и номер
`partCount + 1` дают `400 INVALID_PART_NUMBER`, а пачка из 101 номера — `422 VALIDATION_ERROR`.

---

### B3. Состояние загрузки (возобновление)

**Файлы:** `src/modules/files/files.routes.ts`, `multipart.service.ts`

```
GET /api/files/:id/multipart
→ 200 { id, uploadId, size, partSize, partCount,
        uploadedParts: [1, 2, 3, …], uploadedBytes: 50331648 }
```

Ответ целиком строится из `ListParts`, БД в него не вносит ничего, кроме плана. Клиент сравнивает
`uploadedParts` со своим диапазоном `1..partCount` и догружает недостающее — этого достаточно, чтобы
продолжить загрузку после перезагрузки страницы.

Общий хелпер `listAllParts(file)` в `multipart.service.ts` — **обязательно с пагинацией**: `ListParts`
отдаёт максимум 1 000 частей за раз, и на файле в 10 ГиБ (640 частей) это незаметно, а на 160 ГиБ
молча потеряло бы 8 638 частей.

```ts
async function listAllParts(file: FileRow): Promise<CompletedPart[]> {
  const parts: CompletedPart[] = [];
  let marker: string | undefined;

  do {
    const page = await s3.send(new ListPartsCommand({
      Bucket: file.bucket, Key: file.object_key, UploadId: file.upload_id!,
      PartNumberMarker: marker, MaxParts: 1000,
    }));

    parts.push(...(page.Parts ?? []));
    marker = page.IsTruncated ? page.NextPartNumberMarker : undefined;
  } while (marker);

  return parts;   // S3 отдаёт части по возрастанию PartNumber; порядок страниц его сохраняет
}
```

`upload_id is null` (загрузка уже завершена или это не multipart) → `409 MULTIPART_NOT_FOUND`.

**Готово, когда:** после заливки трёх из семи частей эндпоинт возвращает именно эти три номера и
сумму их размеров.

---

### B4. Завершение — тот же `POST /api/files/:id/complete`

**Файл:** `src/modules/files/files.service.ts`

`completeUpload` ветвится по `file.upload_id`; вся сегодняшняя ветка `HeadObject` остаётся нетронутой
для `upload_source = 'presigned'`.

```
completeUpload(id):
  file = requireFile(id)
  status === 'ready'      → вернуть DTO             (идемпотентность, как сейчас)
  upload_id === null      → существующая ветка HeadObject
  иначе:
    parts = listAllParts(file)
      ↳ NoSuchUpload      → HeadObject: объект есть → загрузка уже завершена, ответ просто потерялся;
                            объекта нет → 409 MULTIPART_NOT_FOUND
    parts.length === 0                   → 409 MULTIPART_INCOMPLETE
    part_count && length !== part_count  → 409 MULTIPART_INCOMPLETE, details { uploaded, expected }
    CompleteMultipartUploadCommand({ MultipartUpload: { Parts: [{ PartNumber, ETag }, …] } })
      ↳ NoSuchUpload      → HeadObject: объект есть → его собрал параллельный complete, идём дальше;
                            объекта нет → 409 MULTIPART_NOT_FOUND
    head = HeadObject
    markFileReady(id, { sizeBytes: head.ContentLength, etag: head.ETag, contentType })
```

Три детали, каждая из которых иначе даёт трудноуловимый баг:

- **`ETag` передаётся ровно тем, что вернул `ListParts`, вместе с кавычками.** S3 сверяет строку.
- **Части идут по возрастанию `PartNumber`.** `ListParts` уже так их отдаёт; отдельная сортировка не
  нужна, но и порядок ломать нельзя.
- **`ListParts` первым, а не `Complete` первым.** На повторный вызов после успеха S3 отвечает
  `NoSuchUpload` на оба, и разобрать «уже готово» от «никогда не было» можно только через
  `HeadObject`. Ветка `NoSuchUpload → HeadObject` — та же логика, по которой сегодня восстанавливается
  запись в статусе `failed`: если объект в хранилище есть, значит загрузка прошла, а потерялось лишь
  подтверждение.
- **Два одновременных `complete` не сериализуются — и не должны.** Гонку разрешает сам S3: второй
  запрос получит `NoSuchUpload`, и фолбэк через `HeadObject` вернёт ему тот же результат, что и
  первому. Поэтому фолбэк нужен **вокруг обоих** вызовов S3 — и `ListParts`, и
  `CompleteMultipartUpload`, — а не только вокруг первого; иначе проигравший в гонке получит 502
  вместо готового файла. `markFileReady` идемпотентен: оба запроса пишут одни и те же значения,
  вычитанные из `HeadObject`.

Блокировку на запись (`pg_advisory_xact_lock` по `id`) сознательно не берём. Она потребовала бы
держать соединение из пула всё время сетевых вызовов в S3 — а выигрыш только косметический, один
лишний `HeadObject` на редкой гонке. Тот же довод действует и в B6.

`markFileReady` берёт итоговый размер и `etag` из `HeadObject`, а не из плана. У собранного из частей
объекта ETag имеет вид `"<hex>-<число частей>"` и вычисляется S3 — придумать его на нашей стороне
нельзя, да и не нужно.

**Готово, когда:** `complete` на полностью залитом файле возвращает `FileDto` со `status: "ready"` и
реальным размером; повторный вызов возвращает то же самое; вызов при одной недостающей части даёт
`409 MULTIPART_INCOMPLETE` с числами в `details`.

---

### B5. Отмена — тот же `DELETE /api/files/:id`

**Файл:** `src/modules/files/files.service.ts`

`deleteFile` после `softDeleteFile` смотрит на строку: если `upload_id` заполнен и статус был
`pending` — `AbortMultipartUploadCommand` вместо `DeleteObjectCommand`. Объекта по ключу ещё нет,
удалять нечего; удалять надо загруженные части, а это делает только `Abort`.

Порядок «сначала БД, потом хранилище» и best-effort-логирование сбоя сохраняются как есть: источник
истины — запись с метаданными.

`Abort` не гарантирует, что части исчезнут немедленно: параллельно летящий `UploadPart` может
приземлиться уже после отмены. Ловить эту гонку здесь не нужно — её добирает уборка из C1.

**Готово, когда:** `DELETE` по незавершённой multipart-записи убирает её из выдачи, а
`ListMultipartUploads` по бакету больше не показывает этот `uploadId`.

---

### B6. Потолок одновременно открытых загрузок

**Файлы:** `src/modules/files/files.repo.ts`, `src/modules/files/multipart.service.ts`

Единственный лимит конкурентности, который сервер может не просто назначить, а **заставить соблюдать**:
`maxConcurrency` клиент волен проигнорировать, а вот открыть одиннадцатую загрузку у него не выйдет.

Проверка `countActiveMultipart()` против `config.uploads.multipartMaxActiveUploads` стоит шагом 3 в
`createMultipartUpload` — между `planMultipart` и `CreateMultipartUploadCommand`. Превышение →
`tooManyRequests(TOO_MANY_ACTIVE_UPLOADS)` с `details: { active, limit }`, чтобы клиент показал не
«что-то пошло не так», а сколько загрузок нужно доделать.

Место в очереди освобождают три события, и все три уже реализованы: `complete` (B4) и
`claimExpiredMultipart` (C1) обнуляют `upload_id`, `DELETE` (B5) ставит `deleted_at`. Отдельного
счётчика в памяти процесса нет намеренно — он разъехался бы с базой при перезапуске и не пережил бы
второй инстанс API.

**Гонку двух одновременных `presign-upload` этот счётчик не закрывает,** и это осознанно: между
`select count` и `insert` может пролезть второй запрос, и активных станет `limit + 1`. Точная
сериализация стоила бы `pg_advisory_xact_lock` на общую константу — то есть выстраивания в очередь
вообще всех стартов загрузок ради лимита, у которого и так нет точного смысла. Перебор на единицу
безвреден: следующий запрос увидит переполнение и откажет.

**Готово, когда:** при `MULTIPART_MAX_ACTIVE_UPLOADS=2` третий `presign-upload` подряд отвечает
`429 TOO_MANY_ACTIVE_UPLOADS` с `active` и `limit` в `details`, а после `complete` или `DELETE` любой
из первых двух — снова `201`.

---

## C. Уборка и документация

Блок про деньги: за части незавершённых загрузок S3 берёт плату, пока их кто-нибудь не отменит.

### C1. `db:cleanup` разбирает брошенные multipart-загрузки

**Файл:** `src/scripts/cleanup-pending.ts`

`listExpiredPending` уже возвращает нужные строки — теперь в них есть `upload_id`. Для строк с ним
вместо `HeadObject` идёт другая ветка:

1. `claimExpiredMultipart(id, ttlHours)` — захватить строку (см. ниже). Ноль строк → пропустить.
2. `listAllParts` → загрузка ещё открыта → `AbortMultipartUpload`.
3. `NoSuchUpload` → `HeadObject`: объект есть → `markFileReady` (загрузка прошла, потерялось
   подтверждение — тот же случай, что уже обрабатывается сегодня); объекта нет → оставить `failed`.

**Уборщик не должен отменить живую загрузку.** `listExpiredPending` выбирает строки по возрасту, но
между выборкой и `Abort` клиент вполне успевает дозалить последнюю часть и позвать `complete` — и
тогда уборка снесёт только что собранный файл. Поэтому строка сначала **захватывается** одним
атомарным запросом, и только потом отменяется:

```sql
-- claimExpiredMultipart(id, ttlHours) → старый upload_id, либо ни одной строки
update files f
   set status = 'failed', upload_id = null, updated_at = now()
  from (select id, upload_id from files where id = $1 for update) old
 where f.id = old.id
   and f.status = 'pending'
   and f.upload_id is not null
   and f.deleted_at is null
   and f.created_at < now() - make_interval(hours => $2)
returning old.upload_id
```

`returning` в `update` отдаёт **новые** значения, поэтому старый `upload_id` вытаскивается подзапросом
в `from` — иначе вернулся бы уже записанный `null`. Ноль строк означает, что запись увёл кто-то другой
(`complete` успел, её удалили, или второй экземпляр скрипта оказался быстрее), и трогать её не надо.
Это же снимает оговорку про порядок обнуления из A3: значение возвращает тот самый запрос, который его
стирает.

Строка помечается `failed` **до** успешного `Abort`, а не после. Если `Abort` затем упадёт, загрузка
останется в бакете уже без ссылки из базы — то есть станет ровно той сиротой, ради которой существует
проход C2. Обратный порядок хуже: он оставляет окно, в котором живой клиент видит `pending` и
продолжает лить части в загрузку, которую уборщик уже решил отменить.

Счётчики в финальном `logger.info` дополнить: `aborted` и `skipped` (сколько строк не захватилось).

**Готово, когда:** брошенная загрузка старше `PENDING_TTL_HOURS` после `npm run db:cleanup` уходит в
`failed`, её частей больше нет в `ListMultipartUploads`, а два запущенных подряд `db:cleanup` не
пытаются отменить одну и ту же загрузку дважды.

---

### C2. Подметание загрузок-сирот

**Файл:** `src/scripts/cleanup-pending.ts` (второй проход, там же)

C1 разбирает то, о чём знает база. Но если процесс упал между `CreateMultipartUpload` и `insertFile`
и откат из B1 не отработал, загрузка есть в S3 и её нет в БД — на неё не смотрит никто и никогда.

Второй проход: `ListMultipartUploadsCommand` по бакету (с пагинацией по `KeyMarker` /
`UploadIdMarker`), для каждой загрузки старше `PENDING_TTL_HOURS` проверить `upload_id` по базе и,
если строки нет, — `Abort`. Возрастной фильтр обязателен: без него подметание отменит загрузку,
которая прямо сейчас идёт.

**Готово, когда:** `uploadId`, созданный вручную и не записанный в БД, после прохода исчезает, а
активная загрузка — остаётся.

---

### C3. Документация API

**Файл:** `server/README.md`

- `## Конфигурация` — восемь новых строк в таблицу переменных.
- `### Ошибки` — пять новых кодов в таблицу; для `TOO_MANY_ACTIVE_UPLOADS` отдельно оговорить, что
  429 здесь — про занятые слоты, а не про частоту запросов, и повторять его имеет смысл только после
  завершения одной из идущих загрузок.
- `### Загрузка` — третий подраздел «**Частями напрямую в S3**» рядом с двумя существующими: схема
  вызовов, дискриминатор `strategy`, таблица примеров разбиения, и явная оговорка, что `complete` и
  `DELETE` — те же самые маршруты.
- `### FileDto` — `uploadSource` теперь `server | presigned | multipart`.
- `## Заметки по устройству` — пункт о том, что частями владеет S3, а не наша база, и почему.

**Готово, когда:** по одному README можно реализовать клиента, не заглядывая в исходники.

---

## Что НЕ меняется

Полезно знать заранее, чтобы не искать несуществующую работу.

- **Бакетный CORS.** Части летят обычным `PUT`, он уже разрешён; остальные команды — серверные.
  `npm run s3:cors` переигрывать не нужно.
- **`MAX_UPLOAD_SIZE_MB` и `middleware/upload.ts`.** Это лимит только для загрузки через сервер, к
  multipart отношения не имеет.
- **`GET /api/files`, `/api/directories`, скачивание.** Запись multipart-файла ничем не отличается от
  любой другой, как только стала `ready`.
- **Статусы `pending | ready | failed`.** Отдельный `uploading` не заводим: `pending` уже значит ровно
  то, что нужно, а новое значение потребовало бы правки констрейнта, zod-схемы фильтра и клиента.
- **Зависимости.** Ни одной новой — в том числе никакой библиотеки-семафора: очередь частей живёт на
  клиенте, а серверный потолок из B6 — это один `select count`.
- **Rate limiting как таковой.** `TOO_MANY_ACTIVE_UPLOADS` считает занятые слоты, а не запросы в
  секунду; общего ограничителя частоты у сервиса не было и в этом плане не появляется.

---

## Что потребуется на клиенте

Вне объёма этого плана, но контракт лучше зафиксировать здесь — и одно предупреждение обязательно.

**Это ломающее изменение.** `client/src/composables/useUpload.ts:87` уже отправляет `size: file.size`,
поэтому сразу после выката файл больше `MULTIPART_THRESHOLD_MB` получит ответ со `strategy:
"multipart"`, в котором нет поля `uploadUrl`, и текущий `putToPresignedUrl` упадёт. Варианты: выкатывать
вместе с клиентом, либо на время выставить `MULTIPART_THRESHOLD_MB` заведомо выше любого рабочего
файла и снизить после релиза клиента.

Что делать на клиенте:

- `src/types/api.ts` — размеченное объединение ответа `presign-upload` по `strategy`; `uploadSource`
  дополнить значением `"multipart"`.
- `src/lib/errors.ts` — тексты для `INVALID_UPLOAD_SIZE`, `INVALID_PART_NUMBER`,
  `MULTIPART_NOT_FOUND`, `MULTIPART_INCOMPLETE`, `TOO_MANY_ACTIVE_UPLOADS`; без них в таблице
  `MESSAGES` пользователь увидит запасной текст. `TOO_MANY_ACTIVE_UPLOADS` **не должен попасть в
  `isRetryable`**: автоматический повтор упрётся в тот же занятый слот, тут нужен текст «доделайте
  начатое», а не кнопка «Повторить».
- `src/api/files.ts` — `putPart(url, blob, options)` поверх существующего `xhrSend` и
  `fetchPartUrls(id, partNumbers)`.
- `src/composables/useUpload.ts` — очередь частей с параллельностью **из `maxConcurrency`, пришедшего
  в ответе**, а не из своей константы: иначе потолок нельзя будет поменять без релиза фронтенда.
  Дальше — прогресс как сумма `loaded` по всем летящим частям (у `xhrSend` события `progress` идут по
  каждому запросу отдельно, так что складывать придётся вручную), повтор упавшей части с перевыпуском
  ссылки через B2, отмена через общий `AbortController` плюс `DELETE /api/files/:id`.
- Отмена и параллельность связаны: `controller.abort()` обрывает все летящие части разом, но
  приземлившиеся до этого части останутся в S3 — поэтому за `abort()` обязателен `DELETE`, иначе
  вместо отменённой загрузки получится брошенная, которую разберёт только суточный `db:cleanup`.

---

## Порядок

`A1` → `A2` → `A3` идут строго последовательно: конфиг нужен планировщику, колонки — репозиторию.
`A4` и `A5` независимы друг от друга и от `A1–A3`, их можно делать параллельно; **`A5` имеет смысл
писать первым по TDD** — это единственная чисто арифметическая часть работы, и она же самая
ошибкоопасная.

**Контрольная точка после A:** `npm run typecheck && npm test` — планировщик покрыт тестами, схема
мигрирована, ни один эндпоинт ещё не тронут.

`B1` разблокирует всё остальное в блоке B (без `uploadId` проверять нечего). `B2` и `B3` независимы
между собой. `B4` требует `listAllParts` из `B3`. `B5` независим и делается в любой момент после `A2`.
`B6` встраивается в `B1` шагом 3 и требует только `countActiveMultipart` из `A3` — но **делать его
стоит сразу за `B1`**, до первых ручных прогонов: без потолка каждая неудачная проба оставляет в
бакете открытую загрузку, и к концу отладки их набирается неприятно много.

**Контрольная точка после B:** сквозной сценарий из `## Проверка` проходит целиком.

`C1` требует `B5` (общая логика `Abort`). `C2` независим. `C3` — последним, по факту реализованного.

Поведение существующих вызовов меняют только `B1` (новое поле `strategy` и другая ветка при большом
`size`), `B4` и `B5` (ветвление внутри, старый путь не тронут). `A1–A5`, `B2`, `B3`, `B6`, `C1`, `C2`
для сегодняшнего клиента невидимы: `B6` он не заметит, пока не упрётся в потолок.

---

## Проверка

Понадобится файл, заведомо больше порога. Готовится так:

```bash
head -c 314572800 /dev/urandom > /tmp/big.bin   # 300 МиБ → 19 частей по 16 МиБ
API=http://localhost:3000/api
KEY=<значение API_KEY из .env>
```

Сквозной сценарий:

```bash
# 1) План: ждём strategy=multipart, partSize=16777216, partCount=19, maxConcurrency=4
curl -sS -X POST "$API/files/presign-upload" -H "X-API-Key: $KEY" \
     -H 'Content-Type: application/json' \
     -d '{"filename":"big.bin","directory":"docs","size":314572800}' | tee /tmp/plan.json

# 2) Залить часть 1 по ссылке из parts[0].url; ждём 200 и заголовок ETag
split -b 16777216 -d /tmp/big.bin /tmp/part_
curl -sS -D- -o /dev/null -X PUT --data-binary @/tmp/part_00 '<parts[0].url>'

# 2a) Параллельно, ровно maxConcurrency штук: части 2..5 одновременно (xargs -P)
printf '%s\n' 1 2 3 4 | xargs -P 4 -I{} sh -c \
  'curl -sS -o /dev/null -w "part {} → %{http_code}\n" -X PUT --data-binary @/tmp/part_0{} "<url {}>"'

# 3) Перевыпустить ссылки (19 < MULTIPART_URL_BATCH, так что шаг 1 отдал все —
#    здесь проверяется именно refresh, а не догрузка следующей пачки)
curl -sS -X POST "$API/files/<id>/multipart/part-urls" -H "X-API-Key: $KEY" \
     -H 'Content-Type: application/json' -d '{"partNumbers":[2,3,4]}'

# 4) Состояние: uploadedParts должен совпасть с реально залитым
curl -sS "$API/files/<id>/multipart" -H "X-API-Key: $KEY"

# 5) Завершить после всех 19 частей; ждём status=ready, size=314572800, etag вида "…-19"
curl -sS -X POST "$API/files/<id>/complete" -H "X-API-Key: $KEY"

# 6) Скачать и сверить побайтово
curl -sS "$API/files/<id>/download-url" -H "X-API-Key: $KEY"
curl -sS -o /tmp/back.bin '<url>' && cmp /tmp/big.bin /tmp/back.bin && echo OK
```

Что должно получиться:

| Что делаем | Что должен вернуть сервер |
|---|---|
| `presign-upload` с `size: 314572800` | `strategy: "multipart"`, `partCount: 19`, `maxConcurrency: 4`, последняя часть 12 МиБ |
| `presign-upload` с `size: 1048576` | `strategy: "single"` со всеми прежними полями |
| `presign-upload` без `size` | `strategy: "single"` — обратная совместимость |
| `presign-upload` с `size` больше `MAX_OBJECT_SIZE_GB` | `413 PAYLOAD_TOO_LARGE` |
| `part-urls` с номером `0` или `20` | `400 INVALID_PART_NUMBER` |
| `part-urls` со 101 номером | `422 VALIDATION_ERROR` |
| `complete`, когда залито 18 частей из 19 | `409 MULTIPART_INCOMPLETE`, `details: { uploaded: 18, expected: 19 }` |
| `complete` повторно после успеха | тот же `FileDto`, `200` |
| `GET /:id/multipart` после `complete` | `409 MULTIPART_NOT_FOUND` |
| `DELETE /:id` на незавершённой загрузке | `204`, и `uploadId` пропал из `ListMultipartUploads` |
| `db:cleanup` по брошенной загрузке старше TTL | статус `failed`, частей в бакете нет |
| Третий `presign-upload` при `MULTIPART_MAX_ACTIVE_UPLOADS=2` | `429 TOO_MANY_ACTIVE_UPLOADS`, `details: { active: 2, limit: 2 }` |
| Он же после `complete` одной из двух | снова `201` |
| Сверка скачанного файла | `cmp` молчит |

Отдельно проверить негатив:

- **Ссылка на часть протухла** — подождать `PRESIGN_PART_TTL_SECONDS` (или временно выставить 60) и
  залить часть: S3 отвечает 403, а повторный `part-urls` выдаёт рабочую ссылку.
- **Пагинация `ListParts`** — самое дорогое место для ошибки, потому что на тестовом файле она молчит.
  Проверяется без гигабайтов: выставить `MULTIPART_PART_SIZE_MB=5` на файле в 300 МиБ (60 частей) и
  временно понизить `MaxParts` в `listAllParts` до 10 — `uploadedParts` обязан вернуть все 60.
- **Откат при сбое `insertFile`** — временно бросить исключение сразу после `insertFile` в B1 и
  убедиться, что `ListMultipartUploads` не показывает осиротевшую загрузку.
- **Загрузка-сирота** — создать `uploadId` вручную (`aws s3api create-multipart-upload`), не записывая
  в БД, и убедиться, что проход C2 её отменяет, а активную загрузку не трогает.
- **Два одновременных `complete`** — запустить два `curl` в фоне по одной и той же записи
  (`curl … & curl … & wait`). Оба обязаны вернуть `200` с одинаковым `FileDto`; `502`, `409
  MULTIPART_NOT_FOUND` или расхождение в `etag` означают, что фолбэк `NoSuchUpload → HeadObject`
  повесили только на `ListParts`, забыв про сам `Complete`.
- **Уборщик против живой загрузки** — выставить `PENDING_TTL_HOURS=0`, начать загрузку и запустить
  `db:cleanup` ровно между заливкой последней части и `complete`. Захват из C1 обязан либо увести
  запись в `failed` целиком (тогда `complete` отвечает `409`), либо не тронуть её вовсе (тогда
  `complete` проходит) — но не оставить наполовину: `status = 'ready'` при уже отменённой в S3
  загрузке недопустим.
- **Два `db:cleanup` одновременно** — запустить в двух терминалах при `PENDING_TTL_HOURS=0`. Каждую
  строку должен захватить ровно один процесс; в логах второго она проходит как `skipped`, а не как
  ошибка `NoSuchUpload`.
