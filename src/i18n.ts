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
  start: `${E.hi} Hi! I save your memes and find them later by text, meaning or mood.

<b>1.</b> Forward me a photo, video or GIF. AI reads the text, transcribes speech and writes what the meme means.
<b>2.</b> Send any words here to search: a caption fragment, a template name or a mood.
<b>3.</b> Type <code>@{bot} words</code> in any chat to send a meme there.

Try it now: forward a meme from any chat.`,
  start_try: "🔍 Try search",
  start_share: "📤 Search in a chat",
  start_help: "💡 How to use",
  first_meme: `\n\n${E.help} Your first meme! Now find it: send a word from it here, or type <code>@{bot}</code> and a word in any chat.`,
  bot_description: "I save your memes and find them later by text, meaning or mood.\n\n• Forward photos, videos and GIFs: AI reads the text and writes what each meme means.\n• Search here, in the web app, or inline in any chat.\n• Import Telegram exports, auto-post to channels, connect AI apps.\n\nPress Start and forward your first meme.",
  bot_short_description: "Save memes and find them by text, meaning or mood. Inline search in any chat.",
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
/export — download all your data as a .zip
/delete_all — delete your account and all data
/channels — auto-post new memes to your channels
/mcp — connect Claude, ChatGPT and other AI apps
/subscribe, /balance — plan and AI balance
/paysupport, /terms — payment support and terms
/about — what the bot stores`,
  help_admin: `
<b>Admin</b>
/grant @username|id [user|admin|paid]
/revoke @username|id
/users — list users
/stats all — spend of all users`,
  about: `${E.help} <b>memesave</b>
<b>Storage.</b> Each meme has a permanent copy in Cloudflare R2, with its text metadata and embeddings. Temporary files (search cache, .zip uploads, export archives) are deleted after max 7 days. Your own OpenRouter key is stored encrypted.
<b>AI.</b> Each meme gets an embedding ({embed}) and a description: photos by {image} (quality in /settings), videos and GIFs by {video}. Single memes are checked with web search; /batch does not use it. When a provider refuses a photo, a fallback model describes it. Search uses {search}.
<b>Access.</b> Only you see your memes. An AI app connected with /mcp gets access only after your approval; you can revoke it in the app.
Every AI request cost is saved to your /stats. /export downloads all your data, /delete_all deletes it.`,
  unknown_cmd: `${E.help} Unknown command. See /help`,
  unsupported: `${E.error} Only photos, videos and GIFs are supported.`,
  saving: `${E.indexing} Saved, indexing…`,
  saved: `${E.done} <b>{title}</b>\n{tags}`,
  album_progress: `${E.indexing} Saved, indexing… {done}/{total}`,
  album_saved: `${E.done} Saved {ready} of {total}:\n{titles}`,
  index_failed: `${E.error} Could not index. Forward it again to retry.{error}`,
  already_saved: `${E.done} Already saved.`,
  link_failed: `${E.error} Could not download media from this link.`,
  processing: `${E.indexing} Still processing.`,
  searching: `${E.search} Searching…`,
  nothing_found: `${E.notFound} Nothing found.`,
  search_failed: `${E.error} Search failed. Try again.{error}`,
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
  batch_failed: `${E.error} Batch failed. {n} photos sent to normal processing.{error}`,
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
  zip_link: `${E.indexing} Upload a .zip with the button: any archive with photos, videos and GIFs, a Telegram Desktop chat export (<b>HTML</b> or <b>JSON</b>), or a memesave /export (restored without AI processing). The type is detected automatically. The link works for 24 h. Photos are described in a half-price batch automatically; videos and GIFs are indexed right away.`,
  zip_button: "Upload .zip",
  app_button: "Open App",
  zip_unpacking: `${E.indexing} Archive uploaded. Unpacking and checking media…`,
  zip_progress: `${E.indexing} Archive ({format}): {found} media, {skipped} duplicates skipped. Saving new ones: {done}/{total}…`,
  fmt_telegram_json: "Telegram JSON export",
  fmt_telegram_html: "Telegram HTML export",
  fmt_files: "media files",
  fmt_memesave: "memesave export",
  zip_done: `${E.done} <b>Archive imported:</b> {imported} new memes, {skipped} duplicates skipped, {failed} failed. Photos are submitted as a half-price batch; I will tell you when it is done.`,
  zip_failed: `${E.error} Archive import failed: {error}`,
  export_started: `${E.indexing} Preparing your data export: memes, metadata, embeddings and all files. I will send a link when the .zip is ready.`,
  export_limit: `${E.help} One export per day. The next one is possible after {time}.`,
  export_done: `${E.done} <b>Your data export is ready:</b> {size} MB, {files} files ({failed} could not be read). The link works for 7 days.`,
  export_button: "Download .zip",
  delete_all_warn: `${E.deleted} <b>Delete your account and all data?</b>
This removes {memes} memes with their files, descriptions and embeddings, your AI spend history, {payments} payments, your subscription and balance, and your OpenRouter key. It cannot be undone. Messages in this chat stay.

Download a copy first: /export
To confirm, send <code>/delete_all {confirm}</code>`,
  delete_all_done: `${E.deleted} Account deleted. Files are removed in the background within minutes. Write again any time to start over as a new user.`,
  export_failed: `${E.error} Data export failed: {error}. You can try /export again.`,
  page_title: "Import a .zip",
  page_lead: "Upload any .zip with photos, videos and GIFs, or a chat exported from Telegram Desktop (HTML or JSON); the type is detected automatically. Unique media are added to your collection.",
  page_drop: "Choose or drop a .zip file",
  page_hint: "Large files are uploaded in parts. Keep this page open until the upload ends.",
  page_done: "Upload complete. You can return to Telegram: the bot shows the progress.",
  page_error: "Upload failed. Open the link from the bot again and retry.",
  page_used: "This link was already used. Send /batch_zip to the bot for a new one.",
  consent_title: "Connect an AI app",
  consent_lead: "{client} wants access to your meme library.",
  consent_domain: "Verified domain: {domain}",
  consent_unverified: "The app name is not verified.",
  consent_redirect: "After you allow it, access goes to {host}.",
  consent_loopback: "Access goes to an app on this computer. Allow it only if you started the connection yourself.",
  consent_as: "Logged in as {user}",
  consent_read: "View, search and download your memes, see your stats and balance, send memes to your chat",
  consent_write: "Upload, delete and reprocess memes",
  consent_allow: "Allow",
  consent_deny: "Deny",
  consent_error: "This connection request is not valid. Start the connection again in the app.",
  bill_btn_subscribe: "Subscribe",
  bill_btn_topup: "Top up",
  bill_btn_balance: "Balance",
  bill_btn_connect_key: "Connect OpenRouter",
  bill_btn_cancel_renew: "Turn off auto-renew",
  bill_btn_resume_renew: "Turn on auto-renew",
  bill_btn_stars_monthly: "⭐ Monthly · {stars}⭐",
  bill_btn_stars_yearly: "⭐ Yearly · {stars}⭐",
  bill_btn_btcpay_monthly: "₿ BTC/XMR · month · {usd}",
  bill_btn_btcpay_yearly: "₿ BTC/XMR · year · {usd}",
  bill_btn_usdt_monthly: "USDT · month · {usd}",
  bill_btn_usdt_yearly: "USDT · year · {usd}",
  bill_btn_topup_stars: "{stars}⭐ → +{usd}",
  bill_btn_topup_btcpay: "₿ BTC/XMR {usd}",
  bill_btn_topup_usdt: "USDT {usd}",
  bill_btn_pay_stars: "Pay {stars}⭐",
  bill_btn_open_checkout: "Open payment page",
  bill_gate_subscribe: `${E.noAccess} memesave is a paid bot. Subscribe to save and search memes: from {price}/month, with {allowance} of AI spend included.`,
  bill_gate_credit: `${E.error} Out of AI credit: this month's included spend is used up and your balance is empty. Top up, or connect your own OpenRouter account (/key).`,
  bill_subscribe: `${E.stats} <b>Subscription</b>
Monthly: <b>{m_usd}</b> ({m_stars}⭐), renews automatically with Stars
Yearly: <b>{y_usd}</b> ({y_stars}⭐) for 12 months
{included}
AI use above the included spend is paid from your balance at the actual API price, or by your own OpenRouter key (/key).
{status}`,
  bill_included_std: "Includes {allowance} of AI spend per month; it does not carry over. With your own OpenRouter key the price is lower.",
  bill_included_byok: "Price with your own OpenRouter key: AI costs go to your key.",
  bill_status_free: "Your account is free: no subscription needed.",
  bill_status_active: "Active until <b>{date}</b>{renew}.",
  bill_renew_on: ", renews automatically",
  bill_renew_off: ", auto-renew off",
  bill_status_none: "No active subscription.",
  bill_balance_card: `${E.stats} <b>Balance</b>
{status}
Included AI spend left this month: <b>{left}</b> of {allowance}
Balance: <b>{balance}</b>
Own OpenRouter key: {own}`,
  bill_yes: "connected",
  bill_no: "not connected",
  bill_topup_choose: `${E.help} Choose a top-up. Stars are added at {rate} per ⭐.`,
  bill_pay_link: `${E.help} {title}: {stars}⭐`,
  bill_crypto_checkout: `${E.help} Pay <b>{usd}</b> in Bitcoin or Monero on the payment page (valid 60 min). I will tell you when the payment is confirmed.`,
  bill_usdt_choose: `${E.help} Choose the USDT network:`,
  bill_usdt_checkout: `${E.help} Pay <b>{usd}</b> in USDT ({network}) on the payment page (valid 60 min). Only this network! I will tell you when the payment is confirmed.`,
  bill_crypto_unavailable: `${E.error} This payment method is not available right now. Try another one.`,
  bill_crypto_limit: `${E.error} Too many payment attempts. Try again in an hour, or pay with Stars.`,
  bill_title_monthly: "memesave · 1 month",
  bill_title_yearly: "memesave · 12 months",
  bill_title_topup: "memesave · AI balance",
  bill_desc_plan: "Saving and searching memes with AI. Includes $0.50 of AI spend per month.",
  bill_desc_byok: "Saving and searching memes with AI using your own OpenRouter key.",
  bill_desc_topup: "Adds {amount} to your AI balance.",
  bill_precheckout_bad: "This invoice is outdated. Open /subscribe again.",
  bill_active: `${E.done} Subscription active until {date}.`,
  bill_renewed: `${E.done} Subscription renewed until {date}.`,
  bill_topped_up: `${E.done} Balance topped up: +{amount} (now {balance}).`,
  bill_renew_failed: `${E.error} Auto-renewal payment failed. Pay before {date} to keep access.`,
  bill_renew_canceled: `${E.done} Auto-renew is off. Access stays until {date}.`,
  bill_renew_resumed: `${E.done} Auto-renew is on again.`,
  bill_allow_80: `${E.indexing} 80% of this month's included AI spend is used ({left} left).`,
  bill_allow_done: `${E.error} This month's included AI spend is used up. Further AI use is paid from your balance ({balance}).`,
  bill_balance_low: `${E.error} Your AI balance is low: {balance}.`,
  bill_balance_empty: `${E.error} Your AI balance is empty. New saves and searches are paused until you top up or connect your own OpenRouter account.`,
  bill_renew_soon: `${E.indexing} Your subscription renews on {date} for {stars}⭐. Keep enough Stars in Telegram.`,
  bill_expiry_soon: `${E.indexing} Your subscription ends on {date}. Renew it to keep saving and searching.`,
  bill_expired: `${E.error} Your subscription has ended. Saving and search are paused; your memes are kept.`,
  paysupport: `${E.help} Payment support: write to the bot owner, {contact}. Include the date and amount of the payment.`,
  terms: `${E.help} <b>Terms</b>
• A subscription gives access to saving and searching memes with AI for the paid period.
• Included AI spend is per 30-day month and does not carry over.
• The balance pays AI costs at the actual API price. Used balance is not refunded; for anything else write to /paysupport.
• Prices may change for future periods.`,
  tier_title: "Describe quality",
  tier_max: "Max",
  tier_medium: "Medium",
  tier_hint: `${E.settings} <b>Describe quality</b>
<b>Max</b> — Gemini 4 Argon: best recognition.
<b>Medium</b> — GPT-6 Luna: about 20× cheaper. Videos always use Gemini Flash.`,
  cmd_subscribe: "Subscription",
  cmd_balance: "Balance and plan",
  cmd_paysupport: "Payment support",
  cmd_terms: "Terms",
  channels: `${E.settings} <b>Channels</b>
New memes you send to the bot or upload in the app are posted to these channels after processing. Albums stay albums.
Tap a channel to turn posting off or on.`,
  channels_none: `${E.settings} <b>Channels</b>
Add the bot to your channel as an admin with the right to post: new memes you send here are posted there after processing. Albums stay albums.`,
  channel_btn_add: "Add to a channel",
  channel_btn_caption: "Caption",
  channel_btn_unlink: "Unlink",
  channel_linked: `${E.done} Channel <b>{title}</b> is linked. New memes are posted there after processing. Settings: /channels`,
  channel_unlinked: `${E.deleted} Channel <b>{title}</b> is unlinked: the bot is no longer an admin there.`,
  channel_lost: `${E.error} Cannot post to <b>{title}</b>: the bot has no rights there. Posting to it is off. Check /channels`,
  channel_gone: "This channel is not linked any more.",
  channel_caption_prompt: `${E.settings} Reply with the caption template for <b>{title}</b> (<code>{id}</code>).
Placeholders: {caption} — your caption, {title} — meme title, {tags} — hashtags, {source} — where it was forwarded from.
Send <code>-</code> for no caption. Now: <code>{current}</code>`,
  channel_caption_saved: `${E.done} Caption template saved.`,
  cmd_channels: "Auto-post to channels",
  admin_only: `${E.noAccess} Admins only.`,
  grant_usage: `${E.help} Usage: /grant @username|id [user|admin|paid]`,
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
  cmd_mcp: "Connect AI apps (MCP)",
  mcp: `${E.help} <b>Connect AI apps (MCP)</b>
Give Claude, ChatGPT, Cursor or another AI app access to your meme library. The app can search, view, download and upload memes and see your balance.

Server URL: <code>{url}</code>

• <b>Claude</b>: Settings → Connectors → Add custom connector, paste the URL.
• <b>Claude Code</b>: run <code>claude mcp add --transport http memesave {url}</code>, then <code>/mcp</code> in Claude Code.
• <b>Cursor and other apps</b>: add the URL as a remote MCP server in the app's MCP settings.

The app opens a login page: log in with Telegram and allow access. For read-only access, clear the option "Upload, delete and reprocess memes". AI search and uploads use your AI balance, as in the bot.
To see or revoke connections, open the app: Account → Settings.`,
  cmd_key: "Own OpenRouter key",
  cmd_batch: "Start a cheap batch import",
  cmd_batch_finish: "Submit the batch import",
  cmd_batch_cancel: "Stop batch mode",
  cmd_batch_zip: "Import a .zip (media or chat export)",
  cmd_export: "Export all your data",
  cmd_delete_all: "Delete your account and all data",
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
  start: `${E.hi} Привет! Я сохраняю ваши мемы и нахожу их потом по тексту, смыслу или настроению.

<b>1.</b> Перешлите мне фото, видео или GIF. ИИ прочитает текст, расшифрует речь и напишет, что значит мем.
<b>2.</b> Отправьте сюда любые слова для поиска: фрагмент подписи, название шаблона или настроение.
<b>3.</b> Пишите <code>@{bot} слова</code> в любом чате, чтобы отправить туда мем.

Попробуйте сейчас: перешлите мем из любого чата.`,
  start_try: "🔍 Попробовать поиск",
  start_share: "📤 Поиск в другом чате",
  start_help: "💡 Как пользоваться",
  first_meme: `\n\n${E.help} Ваш первый мем! Теперь найдите его: отправьте сюда слово из него или напишите <code>@{bot}</code> и слово в любом чате.`,
  bot_description: "Я сохраняю ваши мемы и нахожу их потом по тексту, смыслу или настроению.\n\n• Пересылайте фото, видео и GIF: ИИ читает текст и пишет, что значит каждый мем.\n• Ищите здесь, в веб-приложении или inline в любом чате.\n• Импорт экспортов Telegram, автопостинг в каналы, подключение ИИ-приложений.\n\nНажмите «Начать» и перешлите первый мем.",
  bot_short_description: "Сохраняйте мемы и находите их по тексту, смыслу или настроению. Inline-поиск в любом чате.",
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
/export — скачать все ваши данные в .zip
/delete_all — удалить аккаунт и все данные
/channels — автопостинг новых мемов в ваши каналы
/mcp — подключить Claude, ChatGPT и другие ИИ-приложения
/subscribe, /balance — тариф и баланс ИИ
/paysupport, /terms — поддержка по оплате и условия
/about — что хранит бот`,
  help_admin: `
<b>Админ</b>
/grant @username|id [user|admin|paid]
/revoke @username|id
/users — список пользователей
/stats all — расходы всех пользователей`,
  about: `${E.help} <b>memesave</b>
<b>Хранение.</b> У каждого мема есть постоянная копия в Cloudflare R2, вместе с текстовыми метаданными и эмбеддингами. Временные файлы (кэш поиска, загрузки .zip, архивы экспорта) удаляются максимум через 7 дней. Ваш собственный ключ OpenRouter хранится в зашифрованном виде.
<b>ИИ.</b> Каждый мем получает эмбеддинг ({embed}) и описание: фото — {image} (качество в /settings), видео и GIF — {video}. Одиночные мемы проверяются веб-поиском; /batch его не использует. Если провайдер отказывается обрабатывать фото, его описывает резервная модель. Поиск использует {search}.
<b>Доступ.</b> Ваши мемы видите только вы. ИИ-приложение, подключённое через /mcp, получает доступ только после вашего разрешения; отозвать его можно в приложении.
Стоимость каждого запроса к ИИ сохраняется в /stats. /export скачивает все ваши данные, /delete_all удаляет их.`,
  unknown_cmd: `${E.help} Неизвестная команда. См. /help`,
  unsupported: `${E.error} Поддерживаются только фото, видео и GIF.`,
  saving: `${E.indexing} Сохранено, индексирую…`,
  saved: `${E.done} <b>{title}</b>\n{tags}`,
  album_progress: `${E.indexing} Сохранено, индексирую… {done}/{total}`,
  album_saved: `${E.done} Сохранено {ready} из {total}:\n{titles}`,
  index_failed: `${E.error} Не удалось проиндексировать. Перешлите ещё раз.{error}`,
  already_saved: `${E.done} Уже сохранено.`,
  link_failed: `${E.error} Не удалось скачать медиа по этой ссылке.`,
  processing: `${E.indexing} Ещё обрабатывается.`,
  searching: `${E.search} Ищу…`,
  nothing_found: `${E.notFound} Ничего не найдено.`,
  search_failed: `${E.error} Поиск не удался. Попробуйте ещё раз.{error}`,
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
  batch_failed: `${E.error} Пакет не удался. {n} фото отправлено на обычную обработку.{error}`,
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
  zip_link: `${E.indexing} Загрузите .zip по кнопке: любой архив с фото, видео и GIF, экспорт чата из Telegram Desktop (<b>HTML</b> или <b>JSON</b>) или /export из memesave (восстанавливается без AI-обработки). Тип определяется автоматически. Ссылка работает 24 ч. Фото автоматически описываются пакетом за полцены; видео и GIF индексируются сразу.`,
  zip_button: "Загрузить .zip",
  app_button: "Открыть приложение",
  zip_unpacking: `${E.indexing} Архив загружен. Распаковываю и проверяю медиа…`,
  zip_progress: `${E.indexing} Архив ({format}): {found} медиа, {skipped} дубликатов пропущено. Сохраняю новые: {done}/{total}…`,
  fmt_telegram_json: "экспорт Telegram JSON",
  fmt_telegram_html: "экспорт Telegram HTML",
  fmt_files: "медиафайлы",
  fmt_memesave: "экспорт memesave",
  zip_done: `${E.done} <b>Архив импортирован:</b> {imported} новых мемов, {skipped} дубликатов пропущено, {failed} с ошибкой. Фото отправлены пакетом за полцены; я напишу, когда он будет готов.`,
  zip_failed: `${E.error} Импорт архива не удался: {error}`,
  export_started: `${E.indexing} Готовлю экспорт ваших данных: мемы, метаданные, эмбеддинги и все файлы. Пришлю ссылку, когда .zip будет готов.`,
  export_limit: `${E.help} Экспорт можно делать раз в день. Следующий — после {time}.`,
  export_done: `${E.done} <b>Экспорт данных готов:</b> {size} МБ, {files} файлов ({failed} не удалось прочитать). Ссылка работает 7 дней.`,
  export_button: "Скачать .zip",
  delete_all_warn: `${E.deleted} <b>Удалить аккаунт и все данные?</b>
Будут удалены {memes} мемов с файлами, описаниями и эмбеддингами, история расходов на AI, {payments} платежей, подписка и баланс, а также ключ OpenRouter. Это нельзя отменить. Сообщения в этом чате останутся.

Сначала скачайте копию: /export
Для подтверждения отправьте <code>/delete_all {confirm}</code>`,
  delete_all_done: `${E.deleted} Аккаунт удалён. Файлы удаляются в фоне в течение нескольких минут. Напишите в любой момент, чтобы начать заново как новый пользователь.`,
  export_failed: `${E.error} Экспорт данных не удался: {error}. Попробуйте /export ещё раз.`,
  page_title: "Импорт .zip",
  page_lead: "Загрузите любой .zip с фото, видео и GIF или чат, экспортированный из Telegram Desktop (HTML или JSON); тип определяется автоматически. Уникальные медиа добавятся в вашу коллекцию.",
  page_drop: "Выберите или перетащите .zip",
  page_hint: "Большие файлы загружаются частями. Не закрывайте страницу до конца загрузки.",
  page_done: "Загрузка завершена. Можно вернуться в Telegram: бот покажет прогресс.",
  page_error: "Загрузка не удалась. Откройте ссылку из бота ещё раз и повторите.",
  page_used: "Эта ссылка уже использована. Отправьте боту /batch_zip, чтобы получить новую.",
  consent_title: "Подключение ИИ-приложения",
  consent_lead: "{client} запрашивает доступ к вашей коллекции мемов.",
  consent_domain: "Проверенный домен: {domain}",
  consent_unverified: "Название приложения не проверено.",
  consent_redirect: "После разрешения доступ получит {host}.",
  consent_loopback: "Доступ получит приложение на этом компьютере. Разрешайте, только если вы сами начали подключение.",
  consent_as: "Вы вошли как {user}",
  consent_read: "Просмотр, поиск и скачивание мемов, статистика и баланс, отправка мемов в ваш чат",
  consent_write: "Загрузка, удаление и повторная обработка мемов",
  consent_allow: "Разрешить",
  consent_deny: "Отклонить",
  consent_error: "Запрос на подключение недействителен. Начните подключение в приложении заново.",
  bill_btn_subscribe: "Подписаться",
  bill_btn_topup: "Пополнить",
  bill_btn_balance: "Баланс",
  bill_btn_connect_key: "Подключить OpenRouter",
  bill_btn_cancel_renew: "Выключить автопродление",
  bill_btn_resume_renew: "Включить автопродление",
  bill_btn_stars_monthly: "⭐ Месяц · {stars}⭐",
  bill_btn_stars_yearly: "⭐ Год · {stars}⭐",
  bill_btn_btcpay_monthly: "₿ BTC/XMR · месяц · {usd}",
  bill_btn_btcpay_yearly: "₿ BTC/XMR · год · {usd}",
  bill_btn_usdt_monthly: "USDT · месяц · {usd}",
  bill_btn_usdt_yearly: "USDT · год · {usd}",
  bill_btn_topup_stars: "{stars}⭐ → +{usd}",
  bill_btn_topup_btcpay: "₿ BTC/XMR {usd}",
  bill_btn_topup_usdt: "USDT {usd}",
  bill_btn_pay_stars: "Оплатить {stars}⭐",
  bill_btn_open_checkout: "Открыть страницу оплаты",
  bill_gate_subscribe: `${E.noAccess} memesave — платный бот. Оформите подписку, чтобы сохранять и искать мемы: от {price} в месяц, {allowance} расходов на ИИ включено.`,
  bill_gate_credit: `${E.error} Закончился кредит на ИИ: включённые расходы этого месяца израсходованы, а баланс пуст. Пополните баланс или подключите свой аккаунт OpenRouter (/key).`,
  bill_subscribe: `${E.stats} <b>Подписка</b>
Месяц: <b>{m_usd}</b> ({m_stars}⭐), продлевается автоматически звёздами
Год: <b>{y_usd}</b> ({y_stars}⭐) на 12 месяцев
{included}
Расходы на ИИ сверх включённых оплачиваются с баланса по фактической цене API или вашим ключом OpenRouter (/key).
{status}`,
  bill_included_std: "Включено {allowance} расходов на ИИ в месяц, остаток не переносится. Со своим ключом OpenRouter цена ниже.",
  bill_included_byok: "Цена со своим ключом OpenRouter: расходы на ИИ идут на ваш ключ.",
  bill_status_free: "Ваш аккаунт бесплатный: подписка не нужна.",
  bill_status_active: "Активна до <b>{date}</b>{renew}.",
  bill_renew_on: ", продлевается автоматически",
  bill_renew_off: ", автопродление выключено",
  bill_status_none: "Нет активной подписки.",
  bill_balance_card: `${E.stats} <b>Баланс</b>
{status}
Осталось включённых расходов на ИИ в этом месяце: <b>{left}</b> из {allowance}
Баланс: <b>{balance}</b>
Свой ключ OpenRouter: {own}`,
  bill_yes: "подключён",
  bill_no: "не подключён",
  bill_topup_choose: `${E.help} Выберите пополнение. Звёзды зачисляются по {rate} за ⭐.`,
  bill_pay_link: `${E.help} {title}: {stars}⭐`,
  bill_crypto_checkout: `${E.help} Оплатите <b>{usd}</b> в Bitcoin или Monero на странице оплаты (действует 60 мин). Я напишу, когда платёж подтвердится.`,
  bill_usdt_choose: `${E.help} Выберите сеть USDT:`,
  bill_usdt_checkout: `${E.help} Оплатите <b>{usd}</b> в USDT ({network}) на странице оплаты (действует 60 мин). Только эта сеть! Я напишу, когда платёж подтвердится.`,
  bill_crypto_unavailable: `${E.error} Этот способ оплаты сейчас недоступен. Попробуйте другой.`,
  bill_crypto_limit: `${E.error} Слишком много попыток оплаты. Попробуйте через час или оплатите звёздами.`,
  bill_title_monthly: "memesave · 1 месяц",
  bill_title_yearly: "memesave · 12 месяцев",
  bill_title_topup: "memesave · баланс ИИ",
  bill_desc_plan: "Сохранение и поиск мемов с ИИ. Включено $0.50 расходов на ИИ в месяц.",
  bill_desc_byok: "Сохранение и поиск мемов с ИИ на вашем ключе OpenRouter.",
  bill_desc_topup: "Пополняет баланс ИИ на {amount}.",
  bill_precheckout_bad: "Этот счёт устарел. Откройте /subscribe ещё раз.",
  bill_active: `${E.done} Подписка активна до {date}.`,
  bill_renewed: `${E.done} Подписка продлена до {date}.`,
  bill_topped_up: `${E.done} Баланс пополнен: +{amount} (теперь {balance}).`,
  bill_renew_failed: `${E.error} Не удалось списать автопродление. Оплатите до {date}, чтобы сохранить доступ.`,
  bill_renew_canceled: `${E.done} Автопродление выключено. Доступ сохранится до {date}.`,
  bill_renew_resumed: `${E.done} Автопродление снова включено.`,
  bill_allow_80: `${E.indexing} Израсходовано 80% включённых расходов на ИИ в этом месяце (осталось {left}).`,
  bill_allow_done: `${E.error} Включённые расходы на ИИ в этом месяце закончились. Дальше ИИ оплачивается с баланса ({balance}).`,
  bill_balance_low: `${E.error} Баланс ИИ почти закончился: {balance}.`,
  bill_balance_empty: `${E.error} Баланс ИИ пуст. Новые сохранения и поиск приостановлены, пока вы не пополните баланс или не подключите свой OpenRouter.`,
  bill_renew_soon: `${E.indexing} Подписка продлится {date} за {stars}⭐. Держите достаточно звёзд в Telegram.`,
  bill_expiry_soon: `${E.indexing} Подписка заканчивается {date}. Продлите её, чтобы продолжать сохранять и искать.`,
  bill_expired: `${E.error} Подписка закончилась. Сохранение и поиск приостановлены; ваши мемы сохранены.`,
  paysupport: `${E.help} Поддержка по оплате: напишите владельцу бота, {contact}. Укажите дату и сумму платежа.`,
  terms: `${E.help} <b>Условия</b>
• Подписка даёт доступ к сохранению и поиску мемов с ИИ на оплаченный срок.
• Включённые расходы на ИИ действуют 30 дней и не переносятся.
• Баланс оплачивает расходы на ИИ по фактической цене API. Израсходованный баланс не возвращается; по остальным вопросам — /paysupport.
• Цены на будущие периоды могут меняться.`,
  tier_title: "Качество описания",
  tier_max: "Максимум",
  tier_medium: "Среднее",
  tier_hint: `${E.settings} <b>Качество описания</b>
<b>Максимум</b> — Gemini 4 Argon: лучшее распознавание.
<b>Среднее</b> — GPT-6 Luna: примерно в 20 раз дешевле. Видео всегда описывает Gemini Flash.`,
  cmd_subscribe: "Подписка",
  cmd_balance: "Баланс и тариф",
  cmd_paysupport: "Поддержка по оплате",
  cmd_terms: "Условия",
  channels: `${E.settings} <b>Каналы</b>
Новые мемы, которые вы присылаете боту или загружаете в приложении, после обработки публикуются в этих каналах. Альбомы остаются альбомами.
Нажмите на канал, чтобы выключить или включить публикацию.`,
  channels_none: `${E.settings} <b>Каналы</b>
Добавьте бота в свой канал админом с правом публикации: новые мемы, которые вы присылаете сюда, будут публиковаться там после обработки. Альбомы остаются альбомами.`,
  channel_btn_add: "Добавить в канал",
  channel_btn_caption: "Подпись",
  channel_btn_unlink: "Отвязать",
  channel_linked: `${E.done} Канал <b>{title}</b> привязан. Новые мемы будут публиковаться там после обработки. Настройки: /channels`,
  channel_unlinked: `${E.deleted} Канал <b>{title}</b> отвязан: бот больше не админ в нём.`,
  channel_lost: `${E.error} Не получается опубликовать в <b>{title}</b>: у бота нет прав. Публикация туда выключена. Проверьте /channels`,
  channel_gone: "Этот канал больше не привязан.",
  channel_caption_prompt: `${E.settings} Ответьте на это сообщение шаблоном подписи для <b>{title}</b> (<code>{id}</code>).
Подстановки: {caption} — ваша подпись, {title} — название мема, {tags} — хештеги, {source} — откуда переслано.
Отправьте <code>-</code>, чтобы публиковать без подписи. Сейчас: <code>{current}</code>`,
  channel_caption_saved: `${E.done} Шаблон подписи сохранён.`,
  cmd_channels: "Автопостинг в каналы",
  admin_only: `${E.noAccess} Только для админов.`,
  grant_usage: `${E.help} Использование: /grant @username|id [user|admin|paid]`,
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
  cmd_mcp: "Подключить ИИ-приложения (MCP)",
  mcp: `${E.help} <b>Подключение ИИ-приложений (MCP)</b>
Дайте Claude, ChatGPT, Cursor или другому ИИ-приложению доступ к коллекции мемов. Приложение сможет искать, смотреть, скачивать и загружать мемы и видеть ваш баланс.

Адрес сервера: <code>{url}</code>

• <b>Claude</b>: Настройки → Коннекторы → Добавить свой коннектор, вставьте адрес.
• <b>Claude Code</b>: выполните <code>claude mcp add --transport http memesave {url}</code>, затем <code>/mcp</code> в Claude Code.
• <b>Cursor и другие приложения</b>: добавьте адрес как удалённый MCP-сервер в настройках MCP приложения.

Приложение откроет страницу входа: войдите через Telegram и разрешите доступ. Для доступа только на чтение снимите галочку «Загрузка, удаление и повторная обработка мемов». ИИ-поиск и загрузки тратят ваш баланс ИИ, как в боте.
Подключения можно посмотреть и отозвать в приложении: Аккаунт → Настройки.`,
  cmd_key: "Свой ключ OpenRouter",
  cmd_batch: "Начать дешёвый пакетный импорт",
  cmd_batch_finish: "Отправить пакетный импорт",
  cmd_batch_cancel: "Выключить пакетный режим",
  cmd_batch_zip: "Импорт .zip (медиа или экспорт чата)",
  cmd_export: "Экспорт всех ваших данных",
  cmd_delete_all: "Удалить аккаунт и все данные",
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
