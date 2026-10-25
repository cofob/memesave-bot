export type Lang = "en" | "ru";

export const EMOJI = {
  hi: ["5319024268304982407", "🙋"],
  search: ["5206405591534155434", "🦌"],
  indexing: ["6113844439292054570", "⏳"],
  done: ["5427009714745517609", "✅"],
  error: ["5465665476971471368", "❌"],
  notFound: ["5325864093918175947", "🤷"],
  deleted: ["5231010832107708935", "🗑️"],
  stats: ["5203993413346680064", "📊"],
  settings: ["5341715473882955310", "⚙️"],
  key: ["5330115548900501467", "🔑"],
  admin: ["5381862448754091548", "🥰"],
  noAccess: ["5307810851724481530", "🚫"],
  help: ["5460753627817723162", "💡"],
} as const;
const E = Object.fromEntries(
  Object.entries(EMOJI).map(([k, [id, alt]]) => [k, `<tg-emoji emoji-id="${id}">${alt}</tg-emoji>`]),
) as Record<keyof typeof EMOJI, string>;

const en = {
  no_access: `${E.noAccess} No access. Your id: <code>{id}</code>`,
  no_access_short: "No access",
  start: `${E.hi} Hi! I save your memes and find them later.

• Forward me photos, videos or GIFs.
• Send any text here to search.
• Type <code>@{bot} text</code> in any chat.

Your role: <b>{role}</b>. More: /help`,
  help: `${E.help} <b>How to use</b>
Forward a photo, video or GIF to save it. Send text to search: a caption fragment, a description, a template name or a mood.

/stats — your memes and AI spend
/settings — chat search mode
/delete — reply to a meme to remove it
/key — use your own OpenRouter account
/batch — cheap bulk import of photos (results in minutes to hours)
/batch_zip — import a .zip with media or a Telegram chat export
/batch_status — batch progress
/batch_retry — retry failed memes
/about — what the bot stores`,
  help_admin: `
<b>Admin</b>
/grant @username|id [user|admin]
/revoke @username|id
/users — list users
/stats all — spend of all users`,
  about: `${E.help} <b>memesave</b>
Media stays in Telegram: I keep only file ids and text metadata. Downloaded copies for AI requests live in a temporary cache for max 7 days.
Each meme is embedded ({embed}) and described ({image} / {video}) with web search. Search uses {search}.
Every AI request cost is saved to your /stats.`,
  unknown_cmd: `${E.help} Unknown command. See /help`,
  unsupported: `${E.error} Only photos, videos and GIFs are supported.`,
  saving: `${E.indexing} Saved, indexing…`,
  saved: `${E.done} <b>{title}</b>\n{tags}`,
  index_failed: `${E.error} Could not index. Forward it again to retry.`,
  already_saved: `${E.done} Already saved.`,
  processing: `${E.indexing} Still processing.`,
  searching: `${E.search} Searching…`,
  nothing_found: `${E.notFound} Nothing found.`,
  search_failed: `${E.error} Search failed. Try again.`,
  delete_hint: `${E.help} Reply /delete to a photo, video or GIF.`,
  delete_not_found: `${E.notFound} This meme is not in your collection.`,
  deleted: `${E.deleted} Deleted.`,
  settings: `${E.settings} <b>Chat search mode</b>
<b>Advanced</b> — AI agent refines the search and looks at images.
<b>Fast</b> — one quick pass, media only.`,
  mode_advanced: "Advanced",
  mode_fast: "Fast",
  mode_saved: "Saved",
  stats: `${E.stats} <b>Your stats</b>
Memes: {total} (photos {photo}, videos {video}, GIFs {animation})
Processing: {pending}, failed: {failed}
Spend total: {spend} (bot key {global}, own key {own})
Last 30 days: {spend30}
Average per meme: {avg}`,
  stats_kinds: "\n<b>By kind</b>\n{lines}",
  stats_all: `${E.stats} <b>All users</b>\n{lines}\nTotal: {spend}`,
  key_none: `${E.key} AI requests use the bot's shared OpenRouter key. Connect your own OpenRouter account to pay with your credits.`,
  key_set: `${E.key} Your own OpenRouter key is used for your AI requests.`,
  key_connect: "Connect OpenRouter",
  key_remove: "Remove key",
  key_removed: `${E.key} Key removed. The bot's shared key is used again.`,
  key_connected: `${E.key} OpenRouter connected. Your AI requests now use your own credits.`,
  key_failed: `${E.error} Could not connect OpenRouter: the link expired or was cancelled. Try again.`,
  batch_started: `${E.indexing} <b>Batch mode on.</b> Forward photos, then send /batch_finish. Photos are described at half price, usually within minutes, max 24–96 h. Videos and GIFs are indexed right away as usual. /batch_cancel to stop.`,
  batch_open: `${E.indexing} Batch mode is already on: {n} photos. Send /batch_finish when done.`,
  batch_off: `${E.help} Batch mode is off. Start it with /batch.`,
  batch_empty: `${E.notFound} No photos in this batch.`,
  batch_finishing: `${E.indexing} Submitting {n} photos…`,
  batch_submitted: `${E.indexing} Batch with {n} photos submitted. I will tell you when it is done.`,
  batch_resubmitted: `${E.indexing} {n} photos failed in the batch; submitted them again (attempt {attempt}/{max}).`,
  batch_done: `${E.done} <b>Batch done:</b> {ok} photos described, {n} sent to normal processing. Cost: {cost}.`,
  batch_failed: `${E.error} Batch failed. {n} photos sent to normal processing.`,
  batch_cancelled: `${E.done} Batch mode off. {n} photos are indexed normally.`,
  batch_stopped: `${E.error} <b>Batch stopped:</b> {ok} photos described, {n} failed: <i>{reason}</i>
They were not sent to full-price processing. Fix the cause, then run /batch_retry to retry them as a batch.`,
  batch_status_title: `${E.stats} <b>Batches</b>`,
  batch_status_none: `${E.help} No batches yet. Start one with /batch or /batch_zip.`,
  batch_status_collecting: "Batch mode on: {n} photos collected (/batch_finish to submit).",
  batch_status_row: "{date} · <b>{status}</b>: {photos} photos — {ready} ready, {pending} in progress, {failed} failed · attempt {attempts} · {cost}",
  batch_status_live: "  OpenRouter: {status}, {completed}/{total} done, {failed} failed",
  batch_status_failed: "Failed memes: {n}. Retry them with /batch_retry.",
  batch_retry_none: `${E.notFound} No failed memes.`,
  batch_retry_started: `${E.indexing} Retrying {photos} photos as a half-price batch and {others} videos/GIFs normally…`,
  zip_link: `${E.indexing} Upload a .zip with the button: any archive with photos, videos and GIFs, or a Telegram Desktop chat export (<b>HTML</b> or <b>JSON</b>). The type is detected automatically. The link works for 24 h. Photos are described in a half-price batch automatically; videos and GIFs are indexed right away.`,
  zip_button: "Upload .zip",
  app_button: "Open App",
  zip_unpacking: `${E.indexing} Archive uploaded. Unpacking and checking media…`,
  zip_progress: `${E.indexing} Archive ({format}): {found} media, {skipped} duplicates skipped. Saving new ones: {done}/{total}…`,
  fmt_telegram_json: "Telegram JSON export",
  fmt_telegram_html: "Telegram HTML export",
  fmt_files: "media files",
  zip_done: `${E.done} <b>Archive imported:</b> {imported} new memes, {skipped} duplicates skipped, {failed} failed. Photos are submitted as a half-price batch; I will tell you when it is done.`,
  zip_failed: `${E.error} Archive import failed: {error}`,
  page_title: "Import a .zip",
  page_lead: "Upload any .zip with photos, videos and GIFs, or a chat exported from Telegram Desktop (HTML or JSON); the type is detected automatically. Unique media are added to your collection.",
  page_drop: "Choose or drop a .zip file",
  page_hint: "Large files are uploaded in parts. Keep this page open until the upload ends.",
  page_done: "Upload complete. You can return to Telegram: the bot shows the progress.",
  page_error: "Upload failed. Open the link from the bot again and retry.",
  page_used: "This link was already used. Send /batch_zip to the bot for a new one.",
  admin_only: `${E.noAccess} Admins only.`,
  grant_usage: `${E.help} Usage: /grant @username|id [user|admin]`,
  revoke_usage: `${E.help} Usage: /revoke @username|id`,
  granted: `${E.admin} {target} is now <b>{role}</b>.`,
  granted_pending: `${E.admin} {target} will be <b>{role}</b> after the first message to the bot.`,
  revoked: `${E.admin} Access removed: {target}.`,
  revoke_denied: `${E.noAccess} You cannot revoke this user.`,
  user_not_found: `${E.notFound} User not found: {target}.`,
  users: `${E.admin} <b>Users</b>\n{lines}`,
  users_pending: "\n<b>Pending</b>\n{lines}",
  cmd_start: "Start",
  cmd_help: "How to use",
  cmd_stats: "Memes and AI spend",
  cmd_settings: "Search mode",
  cmd_delete: "Reply to a meme to delete it",
  cmd_about: "About the bot",
  cmd_key: "Own OpenRouter key",
  cmd_batch: "Start a cheap batch import",
  cmd_batch_finish: "Submit the batch import",
  cmd_batch_cancel: "Stop batch mode",
  cmd_batch_zip: "Import a .zip (media or chat export)",
  cmd_batch_status: "Batch progress",
  cmd_batch_retry: "Retry failed memes",
  cmd_grant: "Give access",
  cmd_revoke: "Remove access",
  cmd_users: "List users",
};
export type Key = keyof typeof en;

const ru: Record<Key, string> = {
  no_access: `${E.noAccess} Нет доступа. Ваш id: <code>{id}</code>`,
  no_access_short: "Нет доступа",
  start: `${E.hi} Привет! Я сохраняю ваши мемы и нахожу их потом.

• Пересылайте мне фото, видео или GIF.
• Отправьте любой текст сюда для поиска.
• Пишите <code>@{bot} текст</code> в любом чате.

Ваша роль: <b>{role}</b>. Подробнее: /help`,
  help: `${E.help} <b>Как пользоваться</b>
Перешлите фото, видео или GIF, чтобы сохранить. Отправьте текст для поиска: фрагмент подписи, описание, название шаблона или настроение.

/stats — ваши мемы и расходы на ИИ
/settings — режим поиска в чате
/delete — ответьте на мем, чтобы удалить
/key — свой аккаунт OpenRouter
/batch — дешёвый массовый импорт фото (результат от минут до часов)
/batch_zip — импорт .zip с медиа или экспорта чата Telegram
/batch_status — прогресс пакетов
/batch_retry — повторить мемы с ошибкой
/about — что хранит бот`,
  help_admin: `
<b>Админ</b>
/grant @username|id [user|admin]
/revoke @username|id
/users — список пользователей
/stats all — расходы всех пользователей`,
  about: `${E.help} <b>memesave</b>
Медиа остаются в Telegram: я храню только file id и текстовые метаданные. Копии для запросов к ИИ лежат во временном кэше максимум 7 дней.
Каждый мем получает эмбеддинг ({embed}) и описание ({image} / {video}) с веб-поиском. Поиск использует {search}.
Стоимость каждого запроса к ИИ сохраняется в /stats.`,
  unknown_cmd: `${E.help} Неизвестная команда. См. /help`,
  unsupported: `${E.error} Поддерживаются только фото, видео и GIF.`,
  saving: `${E.indexing} Сохранено, индексирую…`,
  saved: `${E.done} <b>{title}</b>\n{tags}`,
  index_failed: `${E.error} Не удалось проиндексировать. Перешлите ещё раз.`,
  already_saved: `${E.done} Уже сохранено.`,
  processing: `${E.indexing} Ещё обрабатывается.`,
  searching: `${E.search} Ищу…`,
  nothing_found: `${E.notFound} Ничего не найдено.`,
  search_failed: `${E.error} Поиск не удался. Попробуйте ещё раз.`,
  delete_hint: `${E.help} Ответьте /delete на фото, видео или GIF.`,
  delete_not_found: `${E.notFound} Этого мема нет в вашей коллекции.`,
  deleted: `${E.deleted} Удалено.`,
  settings: `${E.settings} <b>Режим поиска в чате</b>
<b>Расширенный</b> — ИИ-агент уточняет поиск и смотрит картинки.
<b>Быстрый</b> — один быстрый проход, только медиа.`,
  mode_advanced: "Расширенный",
  mode_fast: "Быстрый",
  mode_saved: "Сохранено",
  stats: `${E.stats} <b>Ваша статистика</b>
Мемов: {total} (фото {photo}, видео {video}, GIF {animation})
В обработке: {pending}, ошибок: {failed}
Расходы всего: {spend} (ключ бота {global}, свой ключ {own})
За 30 дней: {spend30}
В среднем на мем: {avg}`,
  stats_kinds: "\n<b>По типам</b>\n{lines}",
  stats_all: `${E.stats} <b>Все пользователи</b>\n{lines}\nИтого: {spend}`,
  key_none: `${E.key} Запросы к ИИ идут через общий ключ OpenRouter бота. Подключите свой аккаунт OpenRouter, чтобы платить своими кредитами.`,
  key_set: `${E.key} Для ваших запросов к ИИ используется ваш ключ OpenRouter.`,
  key_connect: "Подключить OpenRouter",
  key_remove: "Удалить ключ",
  key_removed: `${E.key} Ключ удалён. Снова используется общий ключ бота.`,
  key_connected: `${E.key} OpenRouter подключён. Запросы к ИИ теперь оплачиваются вашими кредитами.`,
  key_failed: `${E.error} Не удалось подключить OpenRouter: ссылка истекла или вход отменён. Попробуйте ещё раз.`,
  batch_started: `${E.indexing} <b>Пакетный режим включён.</b> Пересылайте фото, затем отправьте /batch_finish. Фото описываются за полцены, обычно за минуты, максимум 24–96 ч. Видео и GIF индексируются сразу, как обычно. /batch_cancel — выключить.`,
  batch_open: `${E.indexing} Пакетный режим уже включён: {n} фото. Отправьте /batch_finish, когда закончите.`,
  batch_off: `${E.help} Пакетный режим выключен. Включите его командой /batch.`,
  batch_empty: `${E.notFound} В пакете нет фото.`,
  batch_finishing: `${E.indexing} Отправляю {n} фото…`,
  batch_submitted: `${E.indexing} Пакет из {n} фото отправлен. Я напишу, когда он будет готов.`,
  batch_resubmitted: `${E.indexing} {n} фото не обработались в пакете; отправил их ещё раз (попытка {attempt}/{max}).`,
  batch_done: `${E.done} <b>Пакет готов:</b> описано {ok} фото, {n} отправлено на обычную обработку. Стоимость: {cost}.`,
  batch_failed: `${E.error} Пакет не удался. {n} фото отправлено на обычную обработку.`,
  batch_cancelled: `${E.done} Пакетный режим выключен. {n} фото проиндексируются обычным способом.`,
  batch_stopped: `${E.error} <b>Пакет остановлен:</b> описано {ok} фото, {n} с ошибкой: <i>{reason}</i>
Они не отправлены на обработку по полной цене. Устраните причину и запустите /batch_retry, чтобы повторить их пакетом.`,
  batch_status_title: `${E.stats} <b>Пакеты</b>`,
  batch_status_none: `${E.help} Пакетов пока нет. Начните с /batch или /batch_zip.`,
  batch_status_collecting: "Пакетный режим включён: собрано фото: {n} (/batch_finish — отправить).",
  batch_status_row: "{date} · <b>{status}</b>: фото {photos} — готово {ready}, в работе {pending}, с ошибкой {failed} · попытка {attempts} · {cost}",
  batch_status_live: "  OpenRouter: {status}, готово {completed}/{total}, ошибок {failed}",
  batch_status_failed: "Мемов с ошибкой: {n}. Повторить: /batch_retry.",
  batch_retry_none: `${E.notFound} Мемов с ошибкой нет.`,
  batch_retry_started: `${E.indexing} Повторяю {photos} фото пакетом за полцены и {others} видео/GIF обычным способом…`,
  zip_link: `${E.indexing} Загрузите .zip по кнопке: любой архив с фото, видео и GIF или экспорт чата из Telegram Desktop (<b>HTML</b> или <b>JSON</b>). Тип определяется автоматически. Ссылка работает 24 ч. Фото автоматически описываются пакетом за полцены; видео и GIF индексируются сразу.`,
  zip_button: "Загрузить .zip",
  app_button: "Открыть приложение",
  zip_unpacking: `${E.indexing} Архив загружен. Распаковываю и проверяю медиа…`,
  zip_progress: `${E.indexing} Архив ({format}): {found} медиа, {skipped} дубликатов пропущено. Сохраняю новые: {done}/{total}…`,
  fmt_telegram_json: "экспорт Telegram JSON",
  fmt_telegram_html: "экспорт Telegram HTML",
  fmt_files: "медиафайлы",
  zip_done: `${E.done} <b>Архив импортирован:</b> {imported} новых мемов, {skipped} дубликатов пропущено, {failed} с ошибкой. Фото отправлены пакетом за полцены; я напишу, когда он будет готов.`,
  zip_failed: `${E.error} Импорт архива не удался: {error}`,
  page_title: "Импорт .zip",
  page_lead: "Загрузите любой .zip с фото, видео и GIF или чат, экспортированный из Telegram Desktop (HTML или JSON); тип определяется автоматически. Уникальные медиа добавятся в вашу коллекцию.",
  page_drop: "Выберите или перетащите .zip",
  page_hint: "Большие файлы загружаются частями. Не закрывайте страницу до конца загрузки.",
  page_done: "Загрузка завершена. Можно вернуться в Telegram: бот покажет прогресс.",
  page_error: "Загрузка не удалась. Откройте ссылку из бота ещё раз и повторите.",
  page_used: "Эта ссылка уже использована. Отправьте боту /batch_zip, чтобы получить новую.",
  admin_only: `${E.noAccess} Только для админов.`,
  grant_usage: `${E.help} Использование: /grant @username|id [user|admin]`,
  revoke_usage: `${E.help} Использование: /revoke @username|id`,
  granted: `${E.admin} {target} теперь <b>{role}</b>.`,
  granted_pending: `${E.admin} {target} станет <b>{role}</b> после первого сообщения боту.`,
  revoked: `${E.admin} Доступ удалён: {target}.`,
  revoke_denied: `${E.noAccess} Этого пользователя нельзя удалить.`,
  user_not_found: `${E.notFound} Пользователь не найден: {target}.`,
  users: `${E.admin} <b>Пользователи</b>\n{lines}`,
  users_pending: "\n<b>Ожидают</b>\n{lines}",
  cmd_start: "Начать",
  cmd_help: "Как пользоваться",
  cmd_stats: "Мемы и расходы на ИИ",
  cmd_settings: "Режим поиска",
  cmd_delete: "Ответьте на мем, чтобы удалить",
  cmd_about: "О боте",
  cmd_key: "Свой ключ OpenRouter",
  cmd_batch: "Начать дешёвый пакетный импорт",
  cmd_batch_finish: "Отправить пакетный импорт",
  cmd_batch_cancel: "Выключить пакетный режим",
  cmd_batch_zip: "Импорт .zip (медиа или экспорт чата)",
  cmd_batch_status: "Прогресс пакетов",
  cmd_batch_retry: "Повторить мемы с ошибкой",
  cmd_grant: "Дать доступ",
  cmd_revoke: "Забрать доступ",
  cmd_users: "Список пользователей",
};

export const dict: Record<Lang, Record<Key, string>> = { en, ru };

export const langOf = (from?: { language_code?: string }): Lang =>
  from?.language_code?.startsWith("ru") ? "ru" : "en";

export const t = (lang: Lang, key: Key, params: Record<string, string | number> = {}) =>
  dict[lang][key].replace(/\{(\w+)\}/g, (m, k) => (k in params ? String(params[k]) : m));

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const usd = (x: number) => `$${x.toFixed(4)}`;
