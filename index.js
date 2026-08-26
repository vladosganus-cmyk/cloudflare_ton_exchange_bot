import { Buffer } from "node:buffer";
import { Address, internal, SendMode, toNano } from "@ton/core";
import { mnemonicToPrivateKey } from "@ton/crypto";
import { TonClient, WalletContractV5R1 } from "@ton/ton";

globalThis.Buffer ??= Buffer;

const DEFAULT_SETTINGS = {
  markup_percent: "5",
  star_price_uah: "0.65",
  premium_1m_uah: "150",
  premium_3m_uah: "400",
  premium_6m_uah: "700",
  premium_12m_uah: "1200",
  card_number: "1111 2222 3333 4444",
  referral_percent: "10",
  welcome_text:
    "👋 Вітаю, {name}!\n\n" +
    "Тут ти можеш швидко і безпечно купити Telegram Stars, Telegram Premium, криптовалюту TON за гривні,\n" +
    "а також продати TON та USDT за гривні.\n\n" +
    "Обери потрібну послугу в меню нижче. Після оформлення замовлення бот покаже реквізити для оплати."
};

const MIN_TON_AMOUNT = 1;
const MIN_STARS_AMOUNT = 50;
const NETWORK_FEE_RESERVE_TON = 0.05;

const MAIN_MENU = {
  keyboard: [
    [{ text: "⭐ Telegram Stars" }, { text: "💎 TON Crypto" }],
    [{ text: "🎁 Telegram Premium" }],
    [{ text: "🪙 Продати TON" }, { text: "💵 Продати USDT" }],
    [{ text: "👤 Мій профіль" }, { text: "💬 Підтримка" }]
  ],
  resize_keyboard: true
};

const ADMIN_MENU = {
  keyboard: [
    [{ text: "📊 Статистика" }],
    [{ text: "💰 Націнка" }, { text: "💳 Реквізити" }],
    [{ text: "⭐ Ціна Stars" }, { text: "🎁 Ціни Premium" }],
    [{ text: "📜 Тексти" }],
    [{ text: "💎 TON гаманець" }],
    [{ text: "⬅️ Вийти з адмін-панелі" }]
  ],
  resize_keyboard: true
};

const CANCEL_MENU = {
  keyboard: [[{ text: "Скасувати" }]],
  resize_keyboard: true
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS users (
    user_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    first_seen TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ton_address TEXT,
    referrer_id INTEGER,
    referral_balance REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    user_id INTEGER PRIMARY KEY,
    state TEXT,
    data_json TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    message TEXT,
    admin_reply TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    ton_amount REAL NOT NULL,
    ton_address TEXT NOT NULL,
    price_uah INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    save_address INTEGER NOT NULL DEFAULT 0,
    receipt_file_id TEXT,
    receipt_type TEXT,
    tx_info TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS generic_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    order_type TEXT NOT NULL,
    amount REAL NOT NULL,
    details TEXT,
    price_uah INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    receipt_file_id TEXT,
    receipt_type TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT
  )`
];

let schemaReady = false;

export default {
  async fetch(request, env, ctx) {
    try {
      if (!env.BOT_TOKEN || !env.ADMIN_ID || !env.DB) {
        return textResponse("Missing BOT_TOKEN / ADMIN_ID / DB binding", 500);
      }

      await ensureSchema(env);

      const url = new URL(request.url);

      if (request.method === "GET" && url.pathname === "/") {
        return textResponse("OK");
      }

      if (request.method === "GET" && url.pathname.startsWith("/setup/")) {
        const supplied = decodeURIComponent(url.pathname.slice("/setup/".length));
        if (!env.WEBHOOK_SECRET || supplied !== env.WEBHOOK_SECRET) {
          return textResponse("Forbidden", 403);
        }
        const webhookUrl = `${url.origin}/webhook`;
        const result = await tg(env, "setWebhook", {
          url: webhookUrl,
          secret_token: env.WEBHOOK_SECRET,
          allowed_updates: ["message", "callback_query"],
          drop_pending_updates: false
        });
        return jsonResponse({ ok: true, webhookUrl, telegram: result });
      }

      if (request.method === "POST" && url.pathname === "/webhook") {
        if (env.WEBHOOK_SECRET) {
          const header = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
          if (header !== env.WEBHOOK_SECRET) return textResponse("Forbidden", 403);
        }

        const update = await request.json();
        ctx.waitUntil(handleUpdate(env, update));
        return textResponse("OK");
      }

      return textResponse("Not found", 404);
    } catch (e) {
      console.error("FATAL", e?.stack || e);
      return textResponse("OK", 200);
    }
  }
};

async function ensureSchema(env) {
  if (schemaReady) return;
  for (const sql of schemaStatements) {
    await env.DB.prepare(sql).run();
  }
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await env.DB.prepare(
      "INSERT OR IGNORE INTO settings(key, value) VALUES(?, ?)"
    ).bind(key, value).run();
  }
  schemaReady = true;
}

async function handleUpdate(env, update) {
  if (update.message) return handleMessage(env, update.message);
  if (update.callback_query) return handleCallback(env, update.callback_query);
}

async function handleMessage(env, message) {
  if (!message.from || !message.chat) return;
  const userId = message.from.id;
  const chatId = message.chat.id;
  const text = (message.text || "").trim();

  await upsertUser(env, message.from);

  if (text.startsWith("/start")) {
    await clearSession(env, userId);
    const arg = text.split(/\s+/, 2)[1] || "";
    if (arg.startsWith("ref_")) {
      const ref = Number(arg.slice(4));
      if (Number.isInteger(ref) && ref > 0 && ref !== userId) {
        await env.DB.prepare(
          "UPDATE users SET referrer_id = COALESCE(referrer_id, ?) WHERE user_id = ?"
        ).bind(ref, userId).run();
      }
    }
    const welcome = await getSetting(env, "welcome_text", DEFAULT_SETTINGS.welcome_text);
    const name = escapeHtml(message.from.first_name || "друже");
    await sendMessage(env, chatId, welcome.replace("{name}", name), MAIN_MENU);
    return;
  }

  if (text === "/admin") {
    await clearSession(env, userId);
    if (!isAdmin(env, userId)) return;
    await sendMessage(env, chatId, "🛠 <b>Адмін-панель:</b>", ADMIN_MENU);
    return;
  }

  if (text === "Скасувати") {
    await clearSession(env, userId);
    await sendMessage(env, chatId, "Скасовано.", MAIN_MENU);
    return;
  }

  // Admin commands / states
  if (isAdmin(env, userId)) {
    if (await handleAdminMessage(env, message)) return;
  }

  // Main menu
  if (text === "👤 Мій профіль") return showProfile(env, message);
  if (text === "💬 Підтримка") {
    await setSession(env, userId, "support_message", {});
    await sendMessage(env, chatId, "💬 Напиши повідомлення для підтримки одним повідомленням.", CANCEL_MENU);
    return;
  }
  if (text === "⭐ Telegram Stars") return starsStart(env, message);
  if (text === "🎁 Telegram Premium") return premiumStart(env, message);
  if (text === "💎 TON Crypto") {
    await setSession(env, userId, "buy_ton_amount", {});
    await sendMessage(
      env, chatId,
      `💎 Скільки TON бажаєш купити?\nМінімум: ${MIN_TON_AMOUNT} TON\nВведи число, наприклад: <code>10</code>`,
      CANCEL_MENU
    );
    return;
  }
  if (text === "🪙 Продати TON") {
    await setSession(env, userId, "sell_ton_amount", {});
    await sendMessage(
      env, chatId,
      "🪙 <b>Продаж TON</b>\n\nСкільки TON бажаєш продати?\nВведи число, наприклад: <code>10</code>",
      CANCEL_MENU
    );
    return;
  }
  if (text === "💵 Продати USDT") {
    await setSession(env, userId, "sell_usdt_amount", {});
    await sendMessage(
      env, chatId,
      "💵 Скільки USDT бажаєш продати?\nВведи число, наприклад: <code>50</code>",
      CANCEL_MENU
    );
    return;
  }

  const session = await getSession(env, userId);
  if (!session?.state) return;

  switch (session.state) {
    case "support_message":
      return supportReceive(env, message);
    case "buy_ton_amount":
      return buyTonAmount(env, message, session);
    case "buy_ton_address":
      return buyTonAddress(env, message, session);
    case "buy_ton_receipt":
      return buyTonReceipt(env, message, session);
    case "sell_ton_amount":
      return sellTonAmount(env, message, session);
    case "sell_ton_card":
      return sellTonCard(env, message, session);
    case "sell_ton_receipt":
      return sellTonReceipt(env, message, session);
    case "sell_usdt_amount":
      return sellUsdtAmount(env, message);
    case "stars_username":
      return starsUsername(env, message, session);
    case "stars_amount":
      return starsAmount(env, message, session);
    case "stars_receipt":
    case "premium_receipt":
      return genericReceipt(env, message, session);
    case "premium_username":
      return premiumUsername(env, message, session);
    case "admin_markup":
    case "admin_card":
    case "admin_star_price":
    case "admin_welcome":
    case "admin_ticket_reply":
      return handleAdminState(env, message, session);
  }
}

async function handleCallback(env, callback) {
  const userId = callback.from.id;
  const chatId = callback.message?.chat?.id;
  const data = callback.data || "";
  if (!chatId) return;

  await upsertUser(env, callback.from);

  try {
    if (data === "back_to_menu") {
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await answerCallback(env, callback.id);
      return;
    }

    if (data.startsWith("stars_recipient:")) {
      const choice = data.split(":")[1];
      if (choice === "cancel") {
        await clearSession(env, userId);
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await sendMessage(env, chatId, "Скасовано.", MAIN_MENU);
      } else if (choice === "self" && callback.from.username) {
        await setSession(env, userId, "stars_amount", { stars_recipient: `@${callback.from.username}` });
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await sendMessage(
          env, chatId,
          `👤 Зірки для твого акаунта: <b>@${escapeHtml(callback.from.username)}</b>\n\n` +
          `Скільки Telegram Stars бажаєш купити?\nМінімум: ${MIN_STARS_AMOUNT} Stars\n` +
          "Введи число, наприклад: <code>100</code>",
          CANCEL_MENU
        );
      } else {
        await setSession(env, userId, "stars_username", { stars_recipient_type: choice });
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await sendMessage(
          env, chatId,
          choice === "friend"
            ? "👥 Введи Telegram username друга, якому потрібно надіслати Stars.\nНаприклад: <code>@username</code>"
            : "У твого акаунта немає username. Введи username акаунта, наприклад <code>@username</code>.",
          CANCEL_MENU
        );
      }
      await answerCallback(env, callback.id);
      return;
    }

    if (data.startsWith("premium_recipient:")) {
      const choice = data.split(":")[1];
      if (choice === "cancel") {
        await clearSession(env, userId);
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await sendMessage(env, chatId, "Скасовано.", MAIN_MENU);
      } else if (choice === "self" && callback.from.username) {
        await setSession(env, userId, "premium_duration", { premium_recipient: `@${callback.from.username}` });
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await showPremiumDurations(env, chatId);
      } else {
        await setSession(env, userId, "premium_username", { premium_recipient_type: choice });
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await sendMessage(
          env, chatId,
          choice === "friend"
            ? "👥 Введи Telegram username друга, якому потрібно оформити Premium.\nНаприклад: <code>@username</code>"
            : "У твого акаунта немає username. Введи username акаунта, наприклад <code>@username</code>.",
          CANCEL_MENU
        );
      }
      await answerCallback(env, callback.id);
      return;
    }

    if (data.startsWith("premium:")) {
      const session = await getSession(env, userId);
      const recipient = session?.data?.premium_recipient;
      if (!recipient) {
        await clearSession(env, userId);
        await sendMessage(env, chatId, "❌ Не вдалося визначити отримувача Premium. Почни замовлення ще раз.", MAIN_MENU);
        await answerCallback(env, callback.id);
        return;
      }
      const duration = data.split(":")[1];
      const labels = { "1m": "1 місяць", "3m": "3 місяці", "6m": "6 місяців", "12m": "12 місяців" };
      const label = labels[duration] || duration;
      const price = Math.round(Number(await getSetting(env, `premium_${duration}_uah`, "0")));
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await showGenericPayment(
        env, chatId, userId, "premium",
        `🎁 Telegram Premium — ${label}`,
        `👤 Отримувач: <b>${escapeHtml(recipient)}</b>\n🎁 Термін: <b>${label}</b>`,
        price,
        1,
        `Telegram Premium — ${label} → ${recipient}`
      );
      await answerCallback(env, callback.id);
      return;
    }

    if (data === "ton_addr_use_saved") {
      const row = await env.DB.prepare("SELECT ton_address FROM users WHERE user_id=?").bind(userId).first();
      if (!row?.ton_address) {
        await answerCallback(env, callback.id, "Збережена адреса не знайдена.", true);
        return;
      }
      const session = await getSession(env, userId);
      await setSession(env, userId, "ton_address_decision", { ...session.data, ton_address: row.ton_address, save_address: false });
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await showTonOrderSummary(env, chatId, userId);
      await answerCallback(env, callback.id);
      return;
    }

    if (data === "ton_addr_enter_new" || data === "ton_addr_reenter") {
      const session = await getSession(env, userId);
      await setSession(env, userId, "buy_ton_address", session?.data || {});
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(env, chatId, "📤 Введи адресу TON-гаманця для отримання (EQ... або UQ...):", CANCEL_MENU);
      await answerCallback(env, callback.id);
      return;
    }

    if (data === "ton_addr_continue_nosave" || data === "ton_addr_continue_save") {
      const session = await getSession(env, userId);
      await setSession(env, userId, "ton_address_decision", {
        ...session.data,
        save_address: data.endsWith("save")
      });
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await showTonOrderSummary(env, chatId, userId);
      await answerCallback(env, callback.id);
      return;
    }

    if (data === "ton_order_pay") {
      const session = await getSession(env, userId);
      await setSession(env, userId, "buy_ton_receipt", session?.data || {});
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(env, chatId, "📎 Після оплати надішли квитанцію (фото або документ) одним повідомленням.", CANCEL_MENU);
      await answerCallback(env, callback.id);
      return;
    }

    if (data === "ton_order_cancel" || data.startsWith("cancel_generic:")) {
      await clearSession(env, userId);
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(env, chatId, "Скасовано.", MAIN_MENU);
      await answerCallback(env, callback.id);
      return;
    }

    if (data.startsWith("pay_generic:")) {
      const kind = data.split(":")[1];
      const session = await getSession(env, userId);
      const state = kind === "stars" ? "stars_receipt" : kind === "premium" ? "premium_receipt" : "generic_receipt";
      await setSession(env, userId, state, session?.data || {});
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(env, chatId, "📎 Надішли квитанцію одним повідомленням — фото або документ.", CANCEL_MENU);
      await answerCallback(env, callback.id);
      return;
    }

    // Admin callback actions
    if (data.startsWith("confirm_ton_order:")) {
      if (!isAdmin(env, userId)) return;
      const orderId = Number(data.split(":")[1]);
      await answerCallback(env, callback.id, "Відправляю TON...");
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(env, chatId, "⏳ Відправляю TON у мережу, зачекай...");
      const result = await processTonSend(env, orderId);
      if (result.ok) {
        await sendMessage(env, chatId, `✅ TON успішно відправлено.\n${escapeHtml(result.info || "")}`);
      } else {
        await sendMessage(
          env, chatId,
          `❌ Не вдалося відправити TON автоматично:\n${escapeHtml(result.error)}`,
          {
            inline_keyboard: [[{ text: "🔁 Повторити відправку TON", callback_data: `retry_ton_send:${orderId}` }]]
          }
        );
      }
      return;
    }

    if (data.startsWith("retry_ton_send:")) {
      if (!isAdmin(env, userId)) return;
      const orderId = Number(data.split(":")[1]);
      await answerCallback(env, callback.id, "Повторюю...");
      const result = await processTonSend(env, orderId);
      if (result.ok) {
        await editReplyMarkup(env, chatId, callback.message.message_id, null);
        await sendMessage(env, chatId, `✅ TON успішно відправлено.\n${escapeHtml(result.info || "")}`);
      } else {
        await sendMessage(env, chatId, `❌ Знову не вдалося:\n${escapeHtml(result.error)}`);
      }
      return;
    }

    if (data.startsWith("reject_ton_order:")) {
      if (!isAdmin(env, userId)) return;
      const orderId = Number(data.split(":")[1]);
      const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();
      if (!order) return answerCallback(env, callback.id, "Замовлення не знайдено", true);
      await env.DB.prepare("UPDATE orders SET status='rejected', updated_at=CURRENT_TIMESTAMP WHERE id=?").bind(orderId).run();
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(env, order.user_id, "❌ Вашу оплату відхилено.\n\nЗверніться у підтримку.");
      await answerCallback(env, callback.id, "Відхилено");
      return;
    }

    if (data.startsWith("confirm_generic:") || data.startsWith("reject_generic:")) {
      if (!isAdmin(env, userId)) return;
      const approve = data.startsWith("confirm_generic:");
      const orderId = Number(data.split(":")[1]);
      const order = await env.DB.prepare("SELECT * FROM generic_orders WHERE id=?").bind(orderId).first();
      if (!order) return answerCallback(env, callback.id, "Замовлення не знайдено", true);
      if (order.status !== "pending") return answerCallback(env, callback.id, "Це замовлення вже оброблено", true);
      await env.DB.prepare("UPDATE generic_orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(approve ? "completed" : "rejected", orderId).run();
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(
        env,
        order.user_id,
        approve
          ? "✅ <b>Оплату підтверджено!</b>\n\nЗамовлення прийнято до виконання. Якщо товар не надійде найближчим часом — напиши в підтримку."
          : "❌ Оплату не підтверджено. Якщо це помилка — звернись у підтримку."
      );
      await answerCallback(env, callback.id, approve ? "Підтверджено" : "Відхилено");
      return;
    }

    if (data.startsWith("confirm_sell_ton:") || data.startsWith("reject_sell_ton:")) {
      if (!isAdmin(env, userId)) return;
      const approve = data.startsWith("confirm_sell_ton:");
      const orderId = Number(data.split(":")[1]);
      const order = await env.DB.prepare("SELECT * FROM generic_orders WHERE id=?").bind(orderId).first();
      if (!order) return answerCallback(env, callback.id, "Замовлення не знайдено", true);
      if (order.status !== "pending") return answerCallback(env, callback.id, "Цей продаж уже оброблено", true);
      await env.DB.prepare("UPDATE generic_orders SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .bind(approve ? "completed" : "rejected", orderId).run();
      await editReplyMarkup(env, chatId, callback.message.message_id, null);
      await sendMessage(
        env, order.user_id,
        approve
          ? `✅ <b>Надходження TON підтверджено!</b>\n\nСума до виплати: <b>${order.price_uah} грн</b>.\nАдміністратор виконає виплату на вказану картку вручну.`
          : "❌ Переказ TON не підтверджено. Якщо TON уже відправлено — звернись у підтримку та надішли хеш транзакції."
      );
      await answerCallback(env, callback.id, approve ? "TON підтверджено" : "Відхилено");
      return;
    }

    if (data.startsWith("reply_ticket:")) {
      if (!isAdmin(env, userId)) return;
      const ticketId = Number(data.split(":")[1]);
      await setSession(env, userId, "admin_ticket_reply", { ticket_id: ticketId });
      await sendMessage(env, chatId, `✍️ Напиши відповідь на звернення #${ticketId}:`, CANCEL_MENU);
      await answerCallback(env, callback.id);
      return;
    }

    if (data === "admin_text_welcome") {
      if (!isAdmin(env, userId)) return;
      const current = await getSetting(env, "welcome_text", "");
      await setSession(env, userId, "admin_welcome", {});
      await sendMessage(env, chatId, `Поточний текст:\n\n${escapeHtml(current)}\n\nНадішли новий текст:`, CANCEL_MENU);
      await answerCallback(env, callback.id);
      return;
    }

    await answerCallback(env, callback.id);
  } catch (e) {
    console.error("callback error", e?.stack || e);
    await answerCallback(env, callback.id, "Сталася помилка", true);
  }
}

// ---------- Stars / Premium ----------

async function starsStart(env, message) {
  await setSession(env, message.from.id, "stars_recipient_choice", {});
  await sendMessage(
    env, message.chat.id,
    "⭐ <b>Telegram Stars</b>\n\nДля кого купуємо зірки?",
    {
      inline_keyboard: [
        [
          { text: "👤 На мій акаунт", callback_data: "stars_recipient:self" },
          { text: "👥 Другу", callback_data: "stars_recipient:friend" }
        ],
        [{ text: "❌ Скасувати", callback_data: "stars_recipient:cancel" }]
      ]
    }
  );
}

async function starsUsername(env, message, session) {
  const username = normalizeUsername(message.text);
  if (!username) {
    await sendMessage(env, message.chat.id, "❌ Введи коректний Telegram username, наприклад <code>@username</code>.");
    return;
  }
  await setSession(env, message.from.id, "stars_amount", { ...session.data, stars_recipient: username });
  await sendMessage(
    env, message.chat.id,
    `✅ Отримувач: <b>${escapeHtml(username)}</b>\n\nСкільки Telegram Stars бажаєш купити?\n` +
    `Мінімум: ${MIN_STARS_AMOUNT} Stars\nВведи число, наприклад: <code>100</code>`,
    CANCEL_MENU
  );
}

async function starsAmount(env, message, session) {
  const amount = parsePositive(message.text);
  if (!amount || amount < MIN_STARS_AMOUNT) {
    await sendMessage(env, message.chat.id, `❌ Мінімальна кількість для купівлі — ${MIN_STARS_AMOUNT} Stars.`);
    return;
  }
  const recipient = session.data.stars_recipient;
  if (!recipient) {
    await clearSession(env, message.from.id);
    await sendMessage(env, message.chat.id, "❌ Не вдалося визначити отримувача. Почни замовлення ще раз.", MAIN_MENU);
    return;
  }
  const starPrice = Number(await getSetting(env, "star_price_uah", "0.65"));
  const total = Math.ceil(starPrice * amount);
  await showGenericPayment(
    env, message.chat.id, message.from.id, "stars", "⭐ Купівля Telegram Stars",
    `👤 Отримувач: <b>${escapeHtml(recipient)}</b>\n🔢 Кількість: <b>${Math.trunc(amount)} Stars</b>`,
    total, amount, `${Math.trunc(amount)} Stars → ${recipient}`
  );
}

async function premiumStart(env, message) {
  await setSession(env, message.from.id, "premium_recipient_choice", {});
  await sendMessage(
    env, message.chat.id,
    "🎁 <b>Telegram Premium</b>\n\nДля кого купуємо Premium?",
    {
      inline_keyboard: [
        [
          { text: "👤 На мій акаунт", callback_data: "premium_recipient:self" },
          { text: "👥 Другу", callback_data: "premium_recipient:friend" }
        ],
        [{ text: "⬇️ Назад", callback_data: "premium_recipient:cancel" }]
      ]
    }
  );
}

async function premiumUsername(env, message, session) {
  const username = normalizeUsername(message.text);
  if (!username) {
    await sendMessage(env, message.chat.id, "❌ Введи коректний Telegram username, наприклад <code>@username</code>.");
    return;
  }
  await setSession(env, message.from.id, "premium_duration", { ...session.data, premium_recipient: username });
  await sendMessage(env, message.chat.id, `✅ Отримувач Premium: <b>${escapeHtml(username)}</b>`);
  await showPremiumDurations(env, message.chat.id);
}

async function showPremiumDurations(env, chatId) {
  const p1 = await getSetting(env, "premium_1m_uah", "150");
  const p3 = await getSetting(env, "premium_3m_uah", "400");
  const p6 = await getSetting(env, "premium_6m_uah", "700");
  const p12 = await getSetting(env, "premium_12m_uah", "1200");
  await sendMessage(env, chatId, "🎁 Обери термін підписки Telegram Premium:", {
    inline_keyboard: [
      [{ text: `1 місяць — ${p1} грн`, callback_data: "premium:1m" }],
      [{ text: `3 місяці — ${p3} грн`, callback_data: "premium:3m" }],
      [{ text: `6 місяців — ${p6} грн`, callback_data: "premium:6m" }],
      [{ text: `12 місяців — ${p12} грн`, callback_data: "premium:12m" }]
    ]
  });
}

async function showGenericPayment(env, chatId, userId, kind, title, summary, total, amount, details) {
  const card = await getSetting(env, "card_number", "не вказано");
  await setSession(env, userId, `${kind}_pay_confirm`, {
    generic_kind: kind, generic_title: title, generic_summary: summary,
    generic_total: total, generic_amount: amount, generic_details: details
  });
  await sendMessage(
    env, chatId,
    `🧾 <b>${title}</b>\n\n${summary}\n\n💰 До сплати: <b>${total} грн</b>\n\n` +
    `💳 Реквізити для оплати:\n<code>${escapeHtml(card)}</code>\n\n` +
    "Після оплати натисни <b>«💳 Я оплатив»</b> і надішли квитанцію.",
    {
      inline_keyboard: [
        [{ text: "💳 Я оплатив", callback_data: `pay_generic:${kind}` }],
        [{ text: "❌ Скасувати", callback_data: `cancel_generic:${kind}` }]
      ]
    }
  );
}

async function genericReceipt(env, message, session) {
  const media = getReceipt(message);
  if (!media) {
    await sendMessage(env, message.chat.id, "❌ Надішли квитанцію як фото або документ.");
    return;
  }

  const d = session.data;
  const result = await env.DB.prepare(
    `INSERT INTO generic_orders(user_id, order_type, amount, details, price_uah, receipt_file_id, receipt_type)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    message.from.id, d.generic_kind, Number(d.generic_amount || 1),
    d.generic_details || d.generic_summary || "", Number(d.generic_total),
    media.fileId, media.type
  ).run();
  const orderId = result.meta.last_row_id;
  await clearSession(env, message.from.id);

  const username = message.from.username ? `@${message.from.username}` : "немає";
  const caption =
    `🆕 <b>Нове замовлення #${orderId}</b>\n\n` +
    `Тип: <b>${escapeHtml(d.generic_title || d.generic_kind)}</b>\n` +
    `ID покупця: <code>${message.from.id}</code>\nUsername: ${escapeHtml(username)}\n\n` +
    `${d.generic_summary || ""}\nДо сплати: <b>${Number(d.generic_total)} грн</b>\n\n` +
    "Перевір квитанцію та натисни підтвердити або відхилити.";

  const kb = {
    inline_keyboard: [
      [{ text: "✅ Підтвердити", callback_data: `confirm_generic:${orderId}` }],
      [{ text: "❌ Відхилити", callback_data: `reject_generic:${orderId}` }]
    ]
  };
  await sendReceiptToAdmin(env, media, caption, kb);
  await sendMessage(env, message.chat.id, "✅ Квитанцію отримано! Очікуй перевірки адміністратором.", MAIN_MENU);
}

// ---------- Buy TON ----------

async function buyTonAmount(env, message, session) {
  const amount = parsePositive(message.text);
  if (!amount || amount < MIN_TON_AMOUNT) {
    await sendMessage(env, message.chat.id, `❌ Мінімальна кількість для купівлі — ${MIN_TON_AMOUNT} TON.`);
    return;
  }

  await sendMessage(env, message.chat.id, "⏳ Отримую поточний курс...");
  const market = await getTonUahPrice();
  if (!market) {
    await clearSession(env, message.from.id);
    await sendMessage(env, message.chat.id, "❌ Не вдалося отримати курс. Спробуй ще раз трохи пізніше.", MAIN_MENU);
    return;
  }
  const markup = Number(await getSetting(env, "markup_percent", "5"));
  const total = Math.ceil(market * (1 + markup / 100) * amount);
  const data = { ...session.data, ton_amount: amount, ton_total: total };

  const row = await env.DB.prepare("SELECT ton_address FROM users WHERE user_id=?").bind(message.from.id).first();
  if (row?.ton_address) {
    await setSession(env, message.from.id, "ton_address_decision", data);
    await sendMessage(
      env, message.chat.id,
      `📤 У тебе є збережена адреса для отримання TON:\n<code>${escapeHtml(row.ton_address)}</code>\n\nВикористати її чи ввести нову?`,
      {
        inline_keyboard: [
          [{ text: "✅ Використати збережену", callback_data: "ton_addr_use_saved" }],
          [{ text: "✏️ Ввести нову адресу", callback_data: "ton_addr_enter_new" }]
        ]
      }
    );
  } else {
    await setSession(env, message.from.id, "buy_ton_address", data);
    await sendMessage(env, message.chat.id, "📤 Введи адресу свого TON-гаманця для отримання (EQ... або UQ...):", CANCEL_MENU);
  }
}

async function buyTonAddress(env, message, session) {
  const address = (message.text || "").trim();
  if (!isTonAddress(address)) {
    await sendMessage(env, message.chat.id, "❌ Адреса не схожа на коректну TON-адресу. Формат має починатись з EQ або UQ.");
    return;
  }
  await setSession(env, message.from.id, "ton_address_decision", { ...session.data, ton_address: address, save_address: false });
  await sendMessage(
    env, message.chat.id,
    `🆕 Нова адреса:\n<code>${escapeHtml(address)}</code>\n\nМожеш продовжити без збереження або запам'ятати адресу.`,
    {
      inline_keyboard: [
        [{ text: "➡️ Продовжити без збереження", callback_data: "ton_addr_continue_nosave" }],
        [{ text: "💾 Запам'ятати після підтвердження", callback_data: "ton_addr_continue_save" }],
        [{ text: "✏️ Ввести іншу адресу", callback_data: "ton_addr_reenter" }]
      ]
    }
  );
}

async function showTonOrderSummary(env, chatId, userId) {
  const session = await getSession(env, userId);
  const d = session.data;
  const card = await getSetting(env, "card_number", "не вказано");
  await setSession(env, userId, "ton_pay_confirm", d);
  await sendMessage(
    env, chatId,
    `🧾 <b>Деталі замовлення (TON)</b>\n\n` +
    `📤 Отримувач:\n<code>${escapeHtml(d.ton_address)}</code>\n` +
    `🔢 Кількість: <b>${d.ton_amount} TON</b>\n` +
    `💰 До сплати: <b>${d.ton_total} грн</b>\n\n` +
    `💳 Реквізити для оплати:\n<code>${escapeHtml(card)}</code>`,
    {
      inline_keyboard: [
        [{ text: "💳 Я оплатив", callback_data: "ton_order_pay" }],
        [{ text: "❌ Скасувати", callback_data: "ton_order_cancel" }]
      ]
    }
  );
}

async function buyTonReceipt(env, message, session) {
  const media = getReceipt(message);
  if (!media) {
    await sendMessage(env, message.chat.id, "❌ Будь ласка, надішли фото або документ із квитанцією.");
    return;
  }
  const d = session.data;
  const res = await env.DB.prepare(
    `INSERT INTO orders(user_id, ton_amount, ton_address, price_uah, save_address, receipt_file_id, receipt_type)
     VALUES(?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    message.from.id, Number(d.ton_amount), d.ton_address, Number(d.ton_total),
    d.save_address ? 1 : 0, media.fileId, media.type
  ).run();
  const orderId = res.meta.last_row_id;
  await clearSession(env, message.from.id);

  const username = message.from.username ? `@${message.from.username}` : "немає";
  const caption =
    `🆕 <b>Нове замовлення TON #${orderId}</b>\n\n` +
    `ID покупця: <code>${message.from.id}</code>\nUsername: ${escapeHtml(username)}\n\n` +
    `Кількість: <b>${d.ton_amount} TON</b>\n` +
    `Адреса: <code>${escapeHtml(d.ton_address)}</code>\n` +
    `До сплати: <b>${d.ton_total} грн</b>\n\n` +
    "⚠️ Після підтвердження TON відправиться АВТОМАТИЧНО на цю адресу.";

  await sendReceiptToAdmin(env, media, caption, {
    inline_keyboard: [
      [{ text: "✅ Підтвердити й відправити TON", callback_data: `confirm_ton_order:${orderId}` }],
      [{ text: "❌ Відхилити", callback_data: `reject_ton_order:${orderId}` }]
    ]
  });

  await sendMessage(
    env, message.chat.id,
    "✅ Квитанцію отримано! Очікуй підтвердження — після цього TON надійде на вказану адресу автоматично.",
    MAIN_MENU
  );
}

async function processTonSend(env, orderId) {
  try {
    const order = await env.DB.prepare("SELECT * FROM orders WHERE id=?").bind(orderId).first();
    if (!order) return { ok: false, error: "Замовлення не знайдено." };
    if (order.status === "completed") return { ok: false, error: "Замовлення вже виконано." };

    const info = await sendTon(env, order.ton_address, Number(order.ton_amount));
    await env.DB.prepare(
      "UPDATE orders SET status='completed', tx_info=?, updated_at=CURRENT_TIMESTAMP WHERE id=?"
    ).bind(info, orderId).run();

    if (order.save_address) {
      await env.DB.prepare("UPDATE users SET ton_address=? WHERE user_id=?")
        .bind(order.ton_address, order.user_id).run();
    }

    await payReferralBonus(env, order);

    await sendMessage(
      env, order.user_id,
      `✅ Оплату підтверджено!\n\n💎 ${order.ton_amount} TON вже відправлено на твою адресу:\n` +
      `<code>${escapeHtml(order.ton_address)}</code>\n\nПеревір баланс гаманця за кілька хвилин.`
    );

    return { ok: true, info };
  } catch (e) {
    console.error("TON SEND", e?.stack || e);
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---------- Sell TON / USDT ----------

async function sellTonAmount(env, message, session) {
  const amount = parsePositive(message.text);
  if (!amount) return sendMessage(env, message.chat.id, "❌ Введи коректне додатне число.");

  await sendMessage(env, message.chat.id, "⏳ Отримую поточний курс...");
  const market = await getTonUahPrice();
  if (!market) {
    await clearSession(env, message.from.id);
    return sendMessage(env, message.chat.id, "❌ Не вдалося отримати курс. Спробуй пізніше.", MAIN_MENU);
  }
  const markup = Number(await getSetting(env, "markup_percent", "5"));
  const total = Math.ceil(market * (1 - markup / 100) * amount);
  await setSession(env, message.from.id, "sell_ton_card", { sell_ton_amount: amount, sell_ton_total: total });
  await sendMessage(
    env, message.chat.id,
    `🧾 <b>Попередній розрахунок</b>\n\n🪙 До відправки: <b>${amount} TON</b>\n` +
    `💰 Ти отримаєш: <b>${total} грн</b>\n\n` +
    "💳 Тепер введи номер банківської картки, на яку хочеш отримати гривні.\n" +
    "Наприклад: <code>4444 1111 2222 3333</code>",
    CANCEL_MENU
  );
}

async function sellTonCard(env, message, session) {
  const card = cleanCard(message.text || "");
  if (!card) {
    return sendMessage(env, message.chat.id, "❌ Введи від 16 до 19 цифр номера картки.");
  }
  const depositAddress = await getSenderAddress(env);
  const formatted = formatCard(card);
  const data = {
    ...session.data,
    sell_ton_card: formatted,
    sell_ton_deposit_address: depositAddress
  };
  await setSession(env, message.from.id, "sell_ton_receipt", data);
  await sendMessage(
    env, message.chat.id,
    `🪙 <b>Продаж TON — інструкція</b>\n\n` +
    `🔢 Кількість для відправки: <b>${data.sell_ton_amount} TON</b>\n` +
    `💰 Після перевірки ти отримаєш: <b>${data.sell_ton_total} грн</b>\n` +
    `💳 Картка для виплати: <code>${formatted}</code>\n\n` +
    `📥 <b>Відправ TON на наш гаманець:</b>\n<code>${escapeHtml(depositAddress)}</code>\n\n` +
    "Після переказу надішли підтвердження в цей чат.\n\n" +
    "📱 <b>Якщо користуєшся Tonkeeper:</b>\n" +
    "1. Відкрий <b>Історію</b>.\n2. Натисни на потрібний переказ.\n" +
    "3. Зроби скріншот деталей переказу.\n4. Надішли цей скріншот сюди як фото.",
    CANCEL_MENU
  );
}

async function sellTonReceipt(env, message, session) {
  const media = getReceipt(message);
  if (!media) return sendMessage(env, message.chat.id, "❌ Надішли скріншот/квитанцію як фото або документ.");
  const d = session.data;
  const details = `Продаж ${d.sell_ton_amount} TON; виплата ${d.sell_ton_total} грн; картка ${d.sell_ton_card}; TON-гаманець ${d.sell_ton_deposit_address}`;
  const res = await env.DB.prepare(
    `INSERT INTO generic_orders(user_id, order_type, amount, details, price_uah, receipt_file_id, receipt_type)
     VALUES(?, 'sell_ton', ?, ?, ?, ?, ?)`
  ).bind(message.from.id, Number(d.sell_ton_amount), details, Number(d.sell_ton_total), media.fileId, media.type).run();
  const orderId = res.meta.last_row_id;
  await clearSession(env, message.from.id);

  const username = message.from.username ? `@${message.from.username}` : "немає";
  const caption =
    `🆕 <b>Новий продаж TON #${orderId}</b>\n\n` +
    `ID продавця: <code>${message.from.id}</code>\nUsername: ${escapeHtml(username)}\n\n` +
    `🪙 Має надійти: <b>${d.sell_ton_amount} TON</b>\n` +
    `📥 На гаманець: <code>${escapeHtml(d.sell_ton_deposit_address)}</code>\n` +
    `💰 До виплати продавцю: <b>${d.sell_ton_total} грн</b>\n` +
    `💳 Картка продавця: <code>${escapeHtml(d.sell_ton_card)}</code>\n\n` +
    "Перевір надходження TON та квитанцію. Після підтвердження виплату на картку виконай вручну.";

  await sendReceiptToAdmin(env, media, caption, {
    inline_keyboard: [
      [{ text: "✅ Підтвердити отримання TON", callback_data: `confirm_sell_ton:${orderId}` }],
      [{ text: "❌ Відхилити", callback_data: `reject_sell_ton:${orderId}` }]
    ]
  });
  await sendMessage(
    env, message.chat.id,
    `✅ Підтвердження отримано!\n\nАдміністратор перевірить надходження TON. ` +
    `Після підтвердження буде підготовлена виплата <b>${d.sell_ton_total} грн</b> на картку <code>${escapeHtml(d.sell_ton_card)}</code>.`,
    MAIN_MENU
  );
}

async function sellUsdtAmount(env, message) {
  const amount = parsePositive(message.text);
  if (!amount) return sendMessage(env, message.chat.id, "❌ Введи коректне додатне число.");
  await sendMessage(env, message.chat.id, "⏳ Отримую поточний курс...");
  const usdUah = await getUsdUahRate();
  if (!usdUah) {
    await clearSession(env, message.from.id);
    return sendMessage(env, message.chat.id, "❌ Не вдалося отримати курс. Спробуй пізніше.", MAIN_MENU);
  }
  const markup = Number(await getSetting(env, "markup_percent", "5"));
  const total = Math.ceil(usdUah * (1 - markup / 100) * amount);
  await clearSession(env, message.from.id);
  await sendMessage(
    env, message.chat.id,
    `💵 <b>Продаж USDT</b>\n\n🔢 Кількість: <b>${amount} USDT</b>\n` +
    `💰 Ти отримаєш: <b>${total} грн</b>\n\n` +
    "⚠️ Продаж наразі обробляється вручну: адміністратор перевірить надходження й надішле гривні окремо.",
    MAIN_MENU
  );
}

// ---------- Support ----------

async function supportReceive(env, message) {
  const text = message.text || message.caption || "";
  if (!text) return sendMessage(env, message.chat.id, "❌ Надішли текстове повідомлення.");
  const res = await env.DB.prepare("INSERT INTO tickets(user_id, message) VALUES(?, ?)")
    .bind(message.from.id, text).run();
  const ticketId = res.meta.last_row_id;
  await clearSession(env, message.from.id);

  const username = message.from.username ? `@${message.from.username}` : "немає";
  await sendMessage(
    env, Number(env.ADMIN_ID),
    `🆘 <b>Нове звернення #${ticketId}</b>\n\nID: <code>${message.from.id}</code>\n` +
    `Username: ${escapeHtml(username)}\n\n${escapeHtml(text)}`,
    { inline_keyboard: [[{ text: "✍️ Відповісти", callback_data: `reply_ticket:${ticketId}` }]] }
  );
  await sendMessage(env, message.chat.id, "✅ Повідомлення надіслано підтримці.", MAIN_MENU);
}

// ---------- Admin ----------

async function handleAdminMessage(env, message) {
  const text = (message.text || "").trim();
  const chatId = message.chat.id;
  const userId = message.from.id;

  if (text === "⬅️ Вийти з адмін-панелі") {
    await clearSession(env, userId);
    await sendMessage(env, chatId, "Повернувся в головне меню.", MAIN_MENU);
    return true;
  }
  if (text === "📊 Статистика") {
    const users = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
    const tickets = await env.DB.prepare("SELECT COUNT(*) AS c FROM tickets").first();
    await sendMessage(env, chatId, `📊 <b>Статистика</b>\n\n👥 Користувачів: ${users?.c || 0}\n🆘 Звернень: ${tickets?.c || 0}`);
    return true;
  }
  if (text === "💰 Націнка") {
    const current = await getSetting(env, "markup_percent", "5");
    await setSession(env, userId, "admin_markup", {});
    await sendMessage(env, chatId, `Поточна націнка: ${current}%\n\nВведи нову націнку:`, CANCEL_MENU);
    return true;
  }
  if (text === "💳 Реквізити") {
    const current = await getSetting(env, "card_number", "не вказано");
    await setSession(env, userId, "admin_card", {});
    await sendMessage(env, chatId, `Поточна карта: <code>${escapeHtml(current)}</code>\n\nВведи новий номер картки:`, CANCEL_MENU);
    return true;
  }
  if (text === "⭐ Ціна Stars") {
    const current = await getSetting(env, "star_price_uah", "0.65");
    await setSession(env, userId, "admin_star_price", {});
    await sendMessage(env, chatId, `Поточна ціна: ${current} грн за 1 Star\n\nВведи нову ціну:`, CANCEL_MENU);
    return true;
  }
  if (text === "🎁 Ціни Premium") {
    const labels = { "1m": "1 місяць", "3m": "3 місяці", "6m": "6 місяців", "12m": "12 місяців" };
    const lines = [];
    for (const d of Object.keys(labels)) {
      lines.push(`• ${labels[d]}: ${await getSetting(env, `premium_${d}_uah`, "0")} грн`);
    }
    await sendMessage(
      env, chatId,
      `🎁 <b>Поточні ціни Premium:</b>\n\n${lines.join("\n")}\n\n` +
      "Щоб змінити, напиши:\n<code>/setpremium 3m 549</code>\n" +
      "(доступні: 1m, 3m, 6m, 12m)"
    );
    return true;
  }
  if (text.startsWith("/setpremium")) {
    const parts = text.split(/\s+/);
    const valid = ["1m", "3m", "6m", "12m"];
    if (parts.length !== 3 || !valid.includes(parts[1]) || !Number.isFinite(Number(parts[2].replace(",", ".")))) {
      await sendMessage(env, chatId, "❌ Формат: <code>/setpremium 3m 549</code>");
      return true;
    }
    const price = Number(parts[2].replace(",", "."));
    await setSetting(env, `premium_${parts[1]}_uah`, String(price));
    await sendMessage(env, chatId, `✅ Ціну Premium ${parts[1]} оновлено: ${price} грн`);
    return true;
  }
  if (text === "📜 Тексти") {
    await sendMessage(env, chatId, "Який текст редагувати?", {
      inline_keyboard: [[{ text: "👋 Привітання", callback_data: "admin_text_welcome" }]]
    });
    return true;
  }
  if (text === "💎 TON гаманець") {
    try {
      const address = await getSenderAddress(env);
      const balance = await getTonBalance(env, address);
      await sendMessage(
        env, chatId,
        `💎 <b>TON гаманець бота</b>\n\n🌐 Мережа: <code>${escapeHtml(env.TON_NETWORK || "mainnet")}</code>\n` +
        `📬 Адреса:\n<code>${escapeHtml(address)}</code>\n\n💰 Баланс: <b>${balance.toFixed(4)} TON</b>`
      );
    } catch (e) {
      await sendMessage(env, chatId, `❌ Не вдалося отримати TON-гаманець:\n${escapeHtml(e?.message || String(e))}`);
    }
    return true;
  }
  return false;
}

async function handleAdminState(env, message, session) {
  const text = (message.text || "").trim();
  const chatId = message.chat.id;
  const state = session.state;

  if (state === "admin_markup") {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v)) return sendMessage(env, chatId, "❌ Введи коректне число.");
    await setSetting(env, "markup_percent", String(v));
    await clearSession(env, message.from.id);
    return sendMessage(env, chatId, `✅ Націнку оновлено: ${v}%`, ADMIN_MENU);
  }
  if (state === "admin_card") {
    await setSetting(env, "card_number", text);
    await clearSession(env, message.from.id);
    return sendMessage(env, chatId, "✅ Реквізити оновлено.", ADMIN_MENU);
  }
  if (state === "admin_star_price") {
    const v = Number(text.replace(",", "."));
    if (!Number.isFinite(v)) return sendMessage(env, chatId, "❌ Введи коректне число.");
    await setSetting(env, "star_price_uah", String(v));
    await clearSession(env, message.from.id);
    return sendMessage(env, chatId, `✅ Ціну Stars оновлено: ${v} грн`, ADMIN_MENU);
  }
  if (state === "admin_welcome") {
    await setSetting(env, "welcome_text", text);
    await clearSession(env, message.from.id);
    return sendMessage(env, chatId, "✅ Привітання оновлено.", ADMIN_MENU);
  }
  if (state === "admin_ticket_reply") {
    const ticketId = Number(session.data.ticket_id);
    const ticket = await env.DB.prepare("SELECT * FROM tickets WHERE id=?").bind(ticketId).first();
    if (!ticket) {
      await clearSession(env, message.from.id);
      return sendMessage(env, chatId, "Звернення не знайдено.", ADMIN_MENU);
    }
    await env.DB.prepare("UPDATE tickets SET admin_reply=?, status='answered' WHERE id=?").bind(text, ticketId).run();
    await clearSession(env, message.from.id);
    await sendMessage(env, ticket.user_id, `💬 <b>Відповідь підтримки:</b>\n\n${escapeHtml(text)}`);
    return sendMessage(env, chatId, `✅ Відповідь на звернення #${ticketId} надіслано.`, ADMIN_MENU);
  }
}

// ---------- Profile / referrals ----------

async function showProfile(env, message) {
  const userId = message.from.id;
  const user = await env.DB.prepare("SELECT * FROM users WHERE user_id=?").bind(userId).first();
  const refs = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE referrer_id=?").bind(userId).first();
  const completed = await env.DB.prepare("SELECT COUNT(*) AS c FROM orders WHERE user_id=? AND status='completed'").bind(userId).first();
  const genericCompleted = await env.DB.prepare("SELECT COUNT(*) AS c FROM generic_orders WHERE user_id=? AND status='completed'").bind(userId).first();
  const referralOrders = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM orders o JOIN users u ON u.user_id=o.user_id
     WHERE u.referrer_id=? AND o.status='completed'`
  ).bind(userId).first();

  const me = await tg(env, "getMe", {});
  const botUsername = me.result?.username || "";
  const refLink = `https://t.me/${botUsername}?start=ref_${userId}`;
  const balance = Number(user?.referral_balance || 0);
  const balanceStr = balance ? balance.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : "0";

  await sendMessage(
    env, message.chat.id,
    `👤 <b>Твій профіль</b>\n\n` +
    `🏆 Реферальний баланс: ${balanceStr} TON\n` +
    `✅ Виконаних замовлень: ${Number(completed?.c || 0) + Number(genericCompleted?.c || 0)}\n` +
    `👥 Твоїх рефералів: ${refs?.c || 0}\n` +
    `🛍 Замовлень від рефералів: ${referralOrders?.c || 0}\n\n` +
    `🔗 Твоє реферальне посилання:\n${refLink}\n\n` +
    "🎁 Запрошуй друзів і отримуй частину прибутку з їхніх угод!",
    { inline_keyboard: [[{ text: "⬇️ Назад", callback_data: "back_to_menu" }]] },
    true
  );
}

async function payReferralBonus(env, order) {
  const row = await env.DB.prepare("SELECT referrer_id FROM users WHERE user_id=?").bind(order.user_id).first();
  if (!row?.referrer_id) return;
  const markup = Number(await getSetting(env, "markup_percent", "5"));
  const referralPercent = Number(await getSetting(env, "referral_percent", "10"));
  const profitTon = Number(order.ton_amount) * (markup / 100);
  const bonus = Math.round(profitTon * (referralPercent / 100) * 10000) / 10000;
  if (bonus <= 0) return;
  await env.DB.prepare("UPDATE users SET referral_balance=referral_balance+? WHERE user_id=?")
    .bind(bonus, row.referrer_id).run();
  try {
    await sendMessage(
      env, row.referrer_id,
      `🎉 Твій реферал щойно завершив угоду!\nНа твій реферальний баланс нараховано <b>${bonus} TON</b>.`
    );
  } catch {}
}

// ---------- TON wallet ----------

async function getTonWallet(env) {
  if (!env.TON_WALLET_MNEMONIC) throw new Error("TON_WALLET_MNEMONIC не задано в Secrets.");
  const words = env.TON_WALLET_MNEMONIC.trim().split(/\s+/);
  if (words.length !== 24) throw new Error(`Очікувалось 24 слова seed-фрази, отримано ${words.length}.`);
  const keyPair = await mnemonicToPrivateKey(words);
  const mainnet = (env.TON_NETWORK || "mainnet").toLowerCase() !== "testnet";
  const wallet = WalletContractV5R1.create({
    workchain: 0,
    publicKey: keyPair.publicKey,
    walletId: { networkGlobalId: mainnet ? -239 : -3 }
  });
  const endpoint = mainnet
    ? "https://toncenter.com/api/v2/jsonRPC"
    : "https://testnet.toncenter.com/api/v2/jsonRPC";
  const client = new TonClient({ endpoint, apiKey: env.TON_API_KEY || undefined });
  const opened = client.open(wallet);
  return { client, opened, wallet, keyPair };
}

async function getSenderAddress(env) {
  const { wallet } = await getTonWallet(env);
  return wallet.address.toString({ bounceable: false, testOnly: (env.TON_NETWORK || "mainnet") === "testnet" });
}

async function getTonBalance(env, address) {
  const mainnet = (env.TON_NETWORK || "mainnet").toLowerCase() !== "testnet";
  const endpoint = mainnet
    ? "https://toncenter.com/api/v2/jsonRPC"
    : "https://testnet.toncenter.com/api/v2/jsonRPC";
  const client = new TonClient({ endpoint, apiKey: env.TON_API_KEY || undefined });
  const balance = await client.getBalance(Address.parse(address));
  return Number(balance) / 1e9;
}

async function sendTon(env, toAddress, amountTon) {
  if (!(amountTon > 0)) throw new Error("Сума переказу повинна бути більшою за 0 TON.");
  const { opened, wallet, keyPair } = await getTonWallet(env);
  const balanceNano = await opened.getBalance();
  const balanceTon = Number(balanceNano) / 1e9;
  const required = amountTon + NETWORK_FEE_RESERVE_TON;
  if (balanceTon < required) {
    throw new Error(
      `Недостатньо коштів на гарячому гаманці: баланс ${balanceTon.toFixed(4)} TON, ` +
      `потрібно щонайменше ${required.toFixed(4)} TON. Поповни ${wallet.address.toString({ bounceable: false })}.`
    );
  }
  const seqno = await opened.getSeqno();
  await opened.sendTransfer({
    seqno,
    secretKey: keyPair.secretKey,
    messages: [
      internal({
        to: Address.parse(toAddress),
        value: toNano(String(amountTon)),
        bounce: false
      })
    ],
    sendMode: SendMode.PAY_GAS_SEPARATELY + SendMode.IGNORE_ERRORS
  });
  return `seqno=${seqno}; wallet=${wallet.address.toString({ bounceable: false })}`;
}

// ---------- Rates ----------

async function getTonUahPrice() {
  const [tonUsd, usdUah] = await Promise.all([getTonUsdPrice(), getUsdUahRate()]);
  if (!tonUsd || !usdUah) return null;
  return Math.round(tonUsd * usdUah * 100) / 100;
}

async function getTonUsdPrice() {
  try {
    const r = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=the-open-network&vs_currencies=usd", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ton-exchange-bot/1.0)" }
    });
    if (r.ok) {
      const d = await r.json();
      const v = Number(d?.["the-open-network"]?.usd);
      if (v > 0) return v;
    }
  } catch {}
  try {
    const r = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=TONUSDT");
    if (r.ok) {
      const d = await r.json();
      const v = Number(d?.price);
      if (v > 0) return v;
    }
  } catch {}
  return null;
}

async function getUsdUahRate() {
  try {
    const r = await fetch("https://api.monobank.ua/bank/currency", {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; ton-exchange-bot/1.0)" }
    });
    if (r.ok) {
      const d = await r.json();
      for (const x of d) {
        if (x.currencyCodeA === 840 && x.currencyCodeB === 980) {
          const v = Number(x.rateSell || x.rateCross);
          if (v > 0) return v;
        }
      }
    }
  } catch {}
  try {
    const r = await fetch("https://bank.gov.ua/NBUStatService/v1/statdirectory/exchange?valcode=USD&json");
    if (r.ok) {
      const d = await r.json();
      const v = Number(d?.[0]?.rate);
      if (v > 0) return v;
    }
  } catch {}
  return null;
}

// ---------- D1 helpers ----------

async function upsertUser(env, from) {
  await env.DB.prepare(
    `INSERT INTO users(user_id, username, first_name)
     VALUES(?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET username=excluded.username, first_name=excluded.first_name`
  ).bind(from.id, from.username || null, from.first_name || null).run();
}

async function getSetting(env, key, fallback = "") {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key=?").bind(key).first();
  return row?.value ?? fallback;
}

async function setSetting(env, key, value) {
  await env.DB.prepare(
    `INSERT INTO settings(key, value) VALUES(?, ?)
     ON CONFLICT(key) DO UPDATE SET value=excluded.value`
  ).bind(key, String(value)).run();
}

async function getSession(env, userId) {
  const row = await env.DB.prepare("SELECT state, data_json FROM sessions WHERE user_id=?").bind(userId).first();
  if (!row) return null;
  let data = {};
  try { data = JSON.parse(row.data_json || "{}"); } catch {}
  return { state: row.state, data };
}

async function setSession(env, userId, state, data = {}) {
  await env.DB.prepare(
    `INSERT INTO sessions(user_id, state, data_json, updated_at)
     VALUES(?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(user_id) DO UPDATE SET state=excluded.state, data_json=excluded.data_json, updated_at=CURRENT_TIMESTAMP`
  ).bind(userId, state, JSON.stringify(data)).run();
}

async function clearSession(env, userId) {
  await env.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(userId).run();
}

// ---------- Telegram helpers ----------

async function tg(env, method, payload) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await r.json();
  if (!data.ok) throw new Error(`Telegram ${method}: ${JSON.stringify(data)}`);
  return data;
}

async function sendMessage(env, chatId, text, replyMarkup = undefined, disablePreview = false) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: disablePreview
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  return tg(env, "sendMessage", payload);
}

async function sendReceiptToAdmin(env, media, caption, replyMarkup) {
  const payload = {
    chat_id: Number(env.ADMIN_ID),
    caption,
    parse_mode: "HTML",
    reply_markup: replyMarkup
  };
  if (media.type === "photo") {
    payload.photo = media.fileId;
    return tg(env, "sendPhoto", payload);
  }
  payload.document = media.fileId;
  return tg(env, "sendDocument", payload);
}

async function editReplyMarkup(env, chatId, messageId, replyMarkup) {
  return tg(env, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup || { inline_keyboard: [] }
  });
}

async function answerCallback(env, callbackId, text = undefined, showAlert = false) {
  const payload = { callback_query_id: callbackId, show_alert: showAlert };
  if (text) payload.text = text;
  try { return await tg(env, "answerCallbackQuery", payload); } catch {}
}

// ---------- General helpers ----------

function isAdmin(env, userId) {
  return Number(env.ADMIN_ID) === Number(userId);
}

function parsePositive(text) {
  const v = Number(String(text || "").trim().replace(",", "."));
  return Number.isFinite(v) && v > 0 ? v : null;
}

function normalizeUsername(text) {
  let v = String(text || "").trim();
  if (v.startsWith("https://t.me/")) v = "@" + v.split("/").pop();
  if (!v.startsWith("@")) v = "@" + v;
  return /^@[A-Za-z0-9_]{5,32}$/.test(v) ? v : null;
}

function isTonAddress(text) {
  const s = String(text || "").trim();
  if (!/^(EQ|UQ)[A-Za-z0-9_-]{40,60}$/.test(s)) return false;
  try { Address.parse(s); return true; } catch { return false; }
}

function cleanCard(text) {
  const d = String(text || "").replace(/\D/g, "");
  return d.length >= 16 && d.length <= 19 ? d : null;
}

function formatCard(d) {
  return d.match(/.{1,4}/g).join(" ");
}

function getReceipt(message) {
  if (Array.isArray(message.photo) && message.photo.length) {
    return { type: "photo", fileId: message.photo[message.photo.length - 1].file_id };
  }
  if (message.document?.file_id) {
    return { type: "document", fileId: message.document.file_id };
  }
  return null;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function textResponse(text, status = 200) {
  return new Response(text, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
