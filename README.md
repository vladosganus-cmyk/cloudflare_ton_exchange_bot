# TON Exchange Telegram Bot — Cloudflare Workers

Це JavaScript-порт Python/aiogram бота під Cloudflare Workers + Telegram webhook + D1.

## Що перенесено

- `/start`, головне меню, реферали та профіль
- Telegram Stars: собі / другу → кількість → реквізити → квитанція → адмін
- Telegram Premium: собі / другу → термін → реквізити → квитанція → адмін
- Купівля TON → адреса → реквізити → квитанція → автоматична відправка TON після підтвердження адміном
- Продаж TON → кількість → картка → адреса бота → квитанція → підтвердження адміном
- Продаж USDT (ручний сценарій)
- Підтримка та відповідь адміна
- Адмін-панель: статистика, націнка, реквізити, Stars, Premium через `/setpremium`, текст привітання, TON-гаманець
- D1 замість SQLite
- Wallet V5R1 через `@ton/ton`

## Cloudflare Secrets

Додайте через Settings → Variables and Secrets:

- `BOT_TOKEN`
- `ADMIN_ID`
- `WEBHOOK_SECRET` — придумайте довгий випадковий рядок
- `TON_WALLET_MNEMONIC` — 24 слова, тільки як Secret
- `TON_NETWORK` = `mainnet`
- `TON_API_KEY` — необов'язково, але рекомендовано

НЕ додавайте seed-фразу або BOT_TOKEN у GitHub.

## D1

Створіть D1 database і прив'яжіть її до Worker з binding name `DB`.

У `wrangler.jsonc` треба замінити `PUT_YOUR_D1_DATABASE_ID_HERE` на ID вашої D1 бази, якщо деплой іде через GitHub/Wrangler.

Таблиці створюються автоматично при першому запиті до Worker.

## Установка webhook

Після деплою відкрийте один раз:

`https://YOUR-WORKER.workers.dev/setup/YOUR_WEBHOOK_SECRET`

Worker сам викличе `setWebhook`.

Після успішного налаштування адреса `/` повертає `OK`, а Telegram надсилає оновлення на `/webhook`.

## Безпека

- Спочатку перевірте TON-відправку на `testnet`.
- Не публікуйте seed-фразу.
- Для гаманця з великим балансом краще не використовувати серверний hot-wallet.
