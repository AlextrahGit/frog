const http = require("node:http");
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

loadDotEnv(path.join(__dirname, ".env"));

const PORT = Number.parseInt(process.env.PORT || "3000", 10);
const PUBLIC_URL = (process.env.PUBLIC_URL || "").trim();
const BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_BOT_ENABLED = process.env.DISABLE_TELEGRAM_BOT !== "1";
const OWNER_TELEGRAM_ID = Number.parseInt(process.env.OWNER_TELEGRAM_ID || "0", 10) || 0;
const ADMIN_TELEGRAM_IDS = (process.env.ADMIN_TELEGRAM_IDS || "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter(Number.isFinite);
const DEFAULT_REMINDER_BEFORE_END_MINUTES = Number.parseInt(process.env.REMINDER_BEFORE_END_MINUTES || "30", 10) || 30;

const DATA_DIR = resolveDataDir(process.env.DATA_DIR || "");
const DB_PATH = path.join(DATA_DIR, "app.sqlite");

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    telegram_id INTEGER PRIMARY KEY,
    username TEXT,
    first_name TEXT,
    last_name TEXT,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'player',
    chat_id INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS flights (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    status TEXT NOT NULL,
    origin TEXT NOT NULL,
    destination TEXT NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    notes TEXT,
    is_current INTEGER NOT NULL DEFAULT 1,
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    created_by_telegram_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    best_score INTEGER NOT NULL DEFAULT 0,
    route_unlocked INTEGER NOT NULL DEFAULT 0,
    achieved_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(flight_id, telegram_id),
    FOREIGN KEY(flight_id) REFERENCES flights(id) ON DELETE CASCADE,
    FOREIGN KEY(telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    score INTEGER NOT NULL,
    reason TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(flight_id) REFERENCES flights(id) ON DELETE CASCADE,
    FOREIGN KEY(telegram_id) REFERENCES users(telegram_id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    flight_id INTEGER NOT NULL,
    telegram_id INTEGER NOT NULL,
    chat_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    scheduled_at INTEGER NOT NULL,
    message_text TEXT NOT NULL,
    sent_at INTEGER,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(flight_id) REFERENCES flights(id) ON DELETE CASCADE
  );
`);

const selectCurrentFlightStmt = db.prepare(`
  SELECT *
  FROM flights
  WHERE is_current = 1
  ORDER BY id DESC
  LIMIT 1
`);

const selectFlightByIdStmt = db.prepare(`
  SELECT *
  FROM flights
  WHERE id = ?
  LIMIT 1
`);

const deactivateFlightsStmt = db.prepare(`
  UPDATE flights
  SET is_current = 0, updated_at = ?
  WHERE is_current = 1
`);

const insertFlightStmt = db.prepare(`
  INSERT INTO flights (
    status, origin, destination, starts_at, ends_at, notes,
    is_current, notifications_enabled, created_by_telegram_id,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)
`);

const selectUserByTelegramIdStmt = db.prepare(`
  SELECT *
  FROM users
  WHERE telegram_id = ?
  LIMIT 1
`);

const upsertUserStmt = db.prepare(`
  INSERT INTO users (
    telegram_id, username, first_name, last_name, display_name,
    role, chat_id, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(telegram_id) DO UPDATE SET
    username = excluded.username,
    first_name = excluded.first_name,
    last_name = excluded.last_name,
    display_name = excluded.display_name,
    role = excluded.role,
    chat_id = COALESCE(excluded.chat_id, users.chat_id),
    updated_at = excluded.updated_at
`);

const selectScoreStmt = db.prepare(`
  SELECT *
  FROM scores
  WHERE flight_id = ? AND telegram_id = ?
  LIMIT 1
`);

const insertScoreStmt = db.prepare(`
  INSERT INTO scores (
    flight_id, telegram_id, best_score, route_unlocked,
    achieved_at, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const updateScoreStmt = db.prepare(`
  UPDATE scores
  SET best_score = ?, route_unlocked = ?, achieved_at = ?, updated_at = ?
  WHERE id = ?
`);

const insertAttemptStmt = db.prepare(`
  INSERT INTO attempts (
    flight_id, telegram_id, score, reason, created_at
  ) VALUES (?, ?, ?, ?, ?)
`);

const deletePendingNotificationsStmt = db.prepare(`
  DELETE FROM notifications
  WHERE flight_id = ? AND sent_at IS NULL
`);

const deleteAllPendingNotificationsStmt = db.prepare(`
  DELETE FROM notifications
  WHERE sent_at IS NULL
`);

const insertNotificationStmt = db.prepare(`
  INSERT INTO notifications (
    flight_id, telegram_id, chat_id, kind,
    scheduled_at, message_text, sent_at, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)
`);

const selectDueNotificationsStmt = db.prepare(`
  SELECT *
  FROM notifications
  WHERE sent_at IS NULL AND scheduled_at <= ?
  ORDER BY scheduled_at ASC, id ASC
  LIMIT 50
`);

const markNotificationSentStmt = db.prepare(`
  UPDATE notifications
  SET sent_at = ?
  WHERE id = ?
`);

const setSettingStmt = db.prepare(`
  INSERT INTO settings (key, value)
  VALUES (?, ?)
  ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

const getSettingStmt = db.prepare(`
  SELECT value
  FROM settings
  WHERE key = ?
  LIMIT 1
`);

const selectAttemptStatsByFlightStmt = db.prepare(`
  SELECT COUNT(*) AS count
  FROM attempts
  WHERE flight_id = ?
`);

ensureSetting("reminder_before_end_minutes", String(DEFAULT_REMINDER_BEFORE_END_MINUTES));
ensureSetting("bot_update_offset", "0");

const selectLeaderboardStmt = db.prepare(`
  SELECT
    s.telegram_id,
    u.display_name,
    u.username,
    s.best_score,
    s.achieved_at,
    s.route_unlocked
  FROM scores s
  JOIN users u ON u.telegram_id = s.telegram_id
  WHERE s.flight_id = ?
  ORDER BY s.best_score DESC, s.achieved_at ASC, s.telegram_id ASC
`);

const selectPrivilegedUsersStmt = db.prepare(`
  SELECT *
  FROM users
  WHERE telegram_id = ? OR telegram_id IN (${ADMIN_TELEGRAM_IDS.length > 0 ? ADMIN_TELEGRAM_IDS.map(() => "?").join(", ") : "0"})
`);

const chatSessions = new Map();

let updateOffset = Number.parseInt(getSetting("bot_update_offset", "0"), 10) || 0;

function loadDotEnv(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const content = fs.readFileSync(filePath, "utf8");
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function resolveDataDir(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return path.join(__dirname, "data");
  }

  if (path.isAbsolute(value)) {
    return value;
  }

  return path.join(__dirname, value);
}

function ensureSetting(key, value) {
  const existing = getSettingStmt.get(key);
  if (!existing) {
    setSettingStmt.run(key, value);
  }
}

function getSetting(key, fallback = "") {
  const row = getSettingStmt.get(key);
  return row ? row.value : fallback;
}

function nowTs() {
  return Date.now();
}

function resolveRole(telegramId) {
  if (telegramId === OWNER_TELEGRAM_ID) {
    return "owner";
  }

  if (ADMIN_TELEGRAM_IDS.includes(telegramId)) {
    return "admin";
  }

  return "player";
}

function parseTelegramInitData(initDataRaw) {
  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const initData = String(initDataRaw || "").trim();
  if (!initData) {
    throw new Error("Missing initData");
  }

  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) {
    throw new Error("Missing hash");
  }

  const authDate = Number.parseInt(params.get("auth_date") || "0", 10);
  if (!authDate) {
    throw new Error("Missing auth_date");
  }

  const authAgeSeconds = Math.floor(nowTs() / 1000) - authDate;
  if (authAgeSeconds > 60 * 60 * 24) {
    throw new Error("initData is too old");
  }

  const entries = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") {
      continue;
    }

    entries.push(`${key}=${value}`);
  }

  entries.sort((left, right) => left.localeCompare(right));
  const dataCheckString = entries.join("\n");
  const secretKey = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const signature = crypto.createHmac("sha256", secretKey).update(dataCheckString).digest("hex");

  if (signature !== hash) {
    throw new Error("Invalid initData hash");
  }

  const userJson = params.get("user");
  if (!userJson) {
    throw new Error("Missing user in initData");
  }

  const rawUser = JSON.parse(userJson);
  if (!rawUser || typeof rawUser.id !== "number") {
    throw new Error("Invalid user payload");
  }

  return rawUser;
}

function displayNameFromTelegramUser(user) {
  const fullName = [user.first_name, user.last_name].filter(Boolean).join(" ").trim();
  return fullName || (user.username ? `@${user.username}` : `User ${user.id}`);
}

function upsertUserFromTelegram(rawUser, chatId = null) {
  const timestamp = nowTs();
  const role = resolveRole(rawUser.id);
  upsertUserStmt.run(
    rawUser.id,
    rawUser.username || "",
    rawUser.first_name || "",
    rawUser.last_name || "",
    displayNameFromTelegramUser(rawUser),
    role,
    chatId,
    timestamp,
    timestamp
  );

  return selectUserByTelegramIdStmt.get(rawUser.id);
}

function serializeUser(row) {
  if (!row) {
    return null;
  }

  return {
    telegramId: row.telegram_id,
    username: row.username || "",
    displayName: row.display_name,
    role: row.role,
    canManageFlight: row.role === "owner" || row.role === "admin",
    canAdmin: row.role === "admin",
  };
}

function parseFlightTimeInput(text) {
  const raw = String(text || "").trim();
  if (!raw) {
    throw new Error("Empty time");
  }

  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}:00+03:00`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Invalid time: ${text}`);
  }

  return date.getTime();
}

function getCurrentFlightRow() {
  return selectCurrentFlightStmt.get();
}

function getFlightState(row) {
  if (!row) {
    return {
      id: null,
      status: "resting",
      from: "",
      to: "",
      startTime: "",
      endTime: "",
      notes: "",
      isActive: false,
      hasEnded: false,
      notificationsEnabled: false,
    };
  }

  const now = nowTs();
  const isConfiguredFlying = row.status === "flying";
  const isActive = isConfiguredFlying && now >= row.starts_at && now < row.ends_at;
  const hasEnded = now >= row.ends_at;

  return {
    id: row.id,
    status: hasEnded ? "resting" : row.status,
    from: row.origin,
    to: row.destination,
    startTime: new Date(row.starts_at).toISOString(),
    endTime: new Date(row.ends_at).toISOString(),
    notes: row.notes || "",
    isActive,
    hasEnded,
    notificationsEnabled: Boolean(row.notifications_enabled),
  };
}

function getLeaderboardForFlight(flightId) {
  if (!flightId) {
    return [];
  }

  return selectLeaderboardStmt.all(flightId).map((row, index) => ({
    place: index + 1,
    telegramId: row.telegram_id,
    displayName: row.display_name,
    username: row.username || "",
    score: row.best_score,
    achievedAt: row.achieved_at,
    routeUnlocked: Boolean(row.route_unlocked),
  }));
}

function getScoreState(flightId, telegramId) {
  if (!flightId || !telegramId) {
    return {
      bestScore: 0,
      routeUnlocked: false,
    };
  }

  const row = selectScoreStmt.get(flightId, telegramId);
  return {
    bestScore: row ? row.best_score : 0,
    routeUnlocked: Boolean(row && row.route_unlocked),
  };
}

function buildBootstrapPayload(userRow = null) {
  const currentFlightRow = getCurrentFlightRow();
  const currentFlight = getFlightState(currentFlightRow);
  const leaderboard = getLeaderboardForFlight(currentFlight.id);
  const scoreState = userRow ? getScoreState(currentFlight.id, userRow.telegram_id) : { bestScore: 0, routeUnlocked: false };

  return {
    ok: true,
    serverMode: true,
    telegramAuthEnabled: Boolean(BOT_TOKEN),
    user: serializeUser(userRow),
    currentFlight,
    leaderboard,
    myBestScore: scoreState.bestScore,
    routeUnlocked: scoreState.routeUnlocked,
  };
}

function setCurrentFlight({ origin, destination, startsAt, endsAt, notes, createdByTelegramId, notificationsEnabled = true }) {
  if (endsAt <= startsAt) {
    throw new Error("Flight end must be after flight start");
  }

  const timestamp = nowTs();
  deleteAllPendingNotificationsStmt.run();
  deactivateFlightsStmt.run(timestamp);
  insertFlightStmt.run(
    "flying",
    origin,
    destination,
    startsAt,
    endsAt,
    notes || "",
    notificationsEnabled ? 1 : 0,
    createdByTelegramId,
    timestamp,
    timestamp
  );

  const row = selectCurrentFlightStmt.get();
  scheduleNotificationsForFlight(row);
  return row;
}

function setRestingFlight(actorTelegramId) {
  const timestamp = nowTs();
  deleteAllPendingNotificationsStmt.run();
  deactivateFlightsStmt.run(timestamp);
  insertFlightStmt.run(
    "resting",
    "",
    "",
    timestamp,
    timestamp,
    "Rest mode",
    0,
    actorTelegramId,
    timestamp,
    timestamp
  );

  return selectCurrentFlightStmt.get();
}

function recordScore({ telegramId, score, reason }) {
  const flightRow = getCurrentFlightRow();
  if (!flightRow) {
    throw new Error("No current flight");
  }

  if (flightRow.status !== "flying") {
    throw new Error("Flight is not active for scoring");
  }

  const flightState = getFlightState(flightRow);
  if (!flightState.isActive) {
    throw new Error(flightState.hasEnded ? "Flight has already ended" : "Flight has not started yet");
  }

  const timestamp = nowTs();
  insertAttemptStmt.run(flightRow.id, telegramId, score, reason || "", timestamp);

  const existing = selectScoreStmt.get(flightRow.id, telegramId);
  const routeUnlocked = score > 0 || Boolean(existing && existing.route_unlocked);

  if (!existing) {
    insertScoreStmt.run(
      flightRow.id,
      telegramId,
      score,
      routeUnlocked ? 1 : 0,
      score > 0 ? timestamp : null,
      timestamp,
      timestamp
    );
  } else if (score > existing.best_score) {
    updateScoreStmt.run(score, routeUnlocked ? 1 : 0, timestamp, timestamp, existing.id);
  } else if (routeUnlocked && !existing.route_unlocked) {
    updateScoreStmt.run(existing.best_score, 1, existing.achieved_at, timestamp, existing.id);
  }

  return {
    flightRow: selectFlightByIdStmt.get(flightRow.id),
    scoreState: getScoreState(flightRow.id, telegramId),
  };
}

function getPrivilegedUsers() {
  if (!OWNER_TELEGRAM_ID && ADMIN_TELEGRAM_IDS.length === 0) {
    return [];
  }

  return selectPrivilegedUsersStmt.all(OWNER_TELEGRAM_ID, ...ADMIN_TELEGRAM_IDS);
}

function scheduleNotificationsForFlight(flightRow) {
  if (!flightRow || !flightRow.notifications_enabled) {
    return;
  }

  deletePendingNotificationsStmt.run(flightRow.id);

  const reminderMinutes = Number.parseInt(getSetting("reminder_before_end_minutes", String(DEFAULT_REMINDER_BEFORE_END_MINUTES)), 10) || DEFAULT_REMINDER_BEFORE_END_MINUTES;
  const ownerUser = OWNER_TELEGRAM_ID ? selectUserByTelegramIdStmt.get(OWNER_TELEGRAM_ID) : null;
  const fallbackTarget = selectUserByTelegramIdStmt.get(flightRow.created_by_telegram_id);
  const notificationTarget = ownerUser && ownerUser.chat_id ? ownerUser : fallbackTarget;

  if (!notificationTarget || !notificationTarget.chat_id) {
    return;
  }

  const createdAt = nowTs();
  const messages = [
    {
      kind: "flight_start",
      scheduledAt: flightRow.starts_at,
      messageText: `Рейс ${flightRow.origin} → ${flightRow.destination} начался.`,
    },
    {
      kind: "flight_reminder",
      scheduledAt: Math.max(flightRow.starts_at, flightRow.ends_at - reminderMinutes * 60 * 1000),
      messageText: `До конца рейса ${flightRow.origin} → ${flightRow.destination} осталось ${reminderMinutes} минут.`,
    },
    {
      kind: "flight_end",
      scheduledAt: flightRow.ends_at,
      messageText: `Рейс ${flightRow.origin} → ${flightRow.destination} завершён. Игра для этого рейса закрыта.`,
    },
  ];

  for (const message of messages) {
    insertNotificationStmt.run(
      flightRow.id,
      notificationTarget.telegram_id,
      notificationTarget.chat_id,
      message.kind,
      message.scheduledAt,
      message.messageText,
      createdAt
    );
  }
}

function buildFlightEndSummaryMessage(flightRow) {
  if (!flightRow) {
    return "Рейс завершён.";
  }

  const leaderboard = getLeaderboardForFlight(flightRow.id);
  const attemptsCount = selectAttemptStatsByFlightStmt.get(flightRow.id).count;
  const topThree = leaderboard.slice(0, 3);

  const lines = [
    `Рейс ${flightRow.origin} → ${flightRow.destination} завершён.`,
    `Игроков в рейтинге: ${leaderboard.length}.`,
    `Всего попыток: ${attemptsCount}.`,
  ];

  if (topThree.length === 0) {
    lines.push("В этот раз результатов в таблице нет.");
    return lines.join("\n");
  }

  lines.push("");
  lines.push("Топ-3:");

  topThree.forEach((entry, index) => {
    lines.push(`${index + 1}. ${entry.displayName} — ${entry.score}`);
  });

  return lines.join("\n");
}

function buildNotificationText(notification) {
  if (!notification) {
    return "";
  }

  if (notification.kind !== "flight_end") {
    return notification.message_text;
  }

  const flightRow = selectFlightByIdStmt.get(notification.flight_id);
  return buildFlightEndSummaryMessage(flightRow);
}

async function telegramApi(method, payload) {
  if (!TELEGRAM_BOT_ENABLED) {
    throw new Error("Telegram bot transport is disabled");
  }

  if (!BOT_TOKEN) {
    throw new Error("TELEGRAM_BOT_TOKEN is not configured");
  }

  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    throw new Error(`Telegram API ${method} failed with HTTP ${response.status}`);
  }

  const data = await response.json();
  if (!data.ok) {
    throw new Error(`Telegram API ${method} failed: ${data.description || "Unknown error"}`);
  }

  return data.result;
}

async function sendTelegramMessage(chatId, text, extra = {}) {
  return telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    ...extra,
  });
}

async function setTelegramMenuButton() {
  if (!PUBLIC_URL || !BOT_TOKEN || !TELEGRAM_BOT_ENABLED) {
    return;
  }

  try {
    await telegramApi("setChatMenuButton", {
      menu_button: {
        type: "web_app",
        text: "Открыть рейс",
        web_app: {
          url: PUBLIC_URL,
        },
      },
    });
  } catch (error) {
    console.error("[bot] failed to set menu button:", error.message);
  }
}

function buildMiniAppButton() {
  if (!PUBLIC_URL) {
    return undefined;
  }

  return {
    inline_keyboard: [
      [
        {
          text: "Открыть мини-приложение",
          web_app: {
            url: PUBLIC_URL,
          },
        },
      ],
    ],
  };
}

function formatFlightStatusMessage() {
  const flight = getFlightState(getCurrentFlightRow());
  if (!flight.id || flight.status === "resting") {
    return "Сейчас хозяйка не ведёт активный рейс.";
  }

  return [
    `Текущий рейс: ${flight.from} → ${flight.to}`,
    `Старт: ${new Date(flight.startTime).toLocaleString("ru-RU")}`,
    `Финиш: ${new Date(flight.endTime).toLocaleString("ru-RU")}`,
    flight.notes ? `Комментарий: ${flight.notes}` : "",
    flight.isActive ? "Статус: в полёте" : flight.hasEnded ? "Статус: завершён" : "Статус: ещё не начался",
  ]
    .filter(Boolean)
    .join("\n");
}

function parseCommand(text) {
  const [rawCommand, ...args] = String(text || "").trim().split(/\s+/);
  return {
    command: rawCommand || "",
    args,
  };
}

function requirePrivileged(userRow) {
  if (!userRow || (userRow.role !== "owner" && userRow.role !== "admin")) {
    throw new Error("Only owner or admin can use this command");
  }
}

function requireAdmin(userRow) {
  if (!userRow || userRow.role !== "admin") {
    throw new Error("Only admin can use this command");
  }
}

async function processFlightWizardStep(message, userRow) {
  const session = chatSessions.get(message.chat.id);
  if (!session || session.kind !== "setflight") {
    return false;
  }

  const text = String(message.text || "").trim();
  if (!text) {
    await sendTelegramMessage(message.chat.id, "Нужен текстовый ответ. Или отправь /cancel.");
    return true;
  }

  if (text === "/cancel") {
    chatSessions.delete(message.chat.id);
    await sendTelegramMessage(message.chat.id, "Создание рейса отменено.");
    return true;
  }

  if (session.step === "origin") {
    session.data.origin = text;
    session.step = "destination";
    await sendTelegramMessage(message.chat.id, "Введи точку назначения. Например: Istanbul");
    return true;
  }

  if (session.step === "destination") {
    session.data.destination = text;
    session.step = "start";
    await sendTelegramMessage(message.chat.id, "Введи старт рейса в формате `YYYY-MM-DD HH:MM` или ISO со смещением.", {
      parse_mode: "Markdown",
    });
    return true;
  }

  if (session.step === "start") {
    try {
      session.data.startsAt = parseFlightTimeInput(text);
      session.step = "end";
      await sendTelegramMessage(message.chat.id, "Теперь введи конец рейса в формате `YYYY-MM-DD HH:MM` или ISO со смещением.", {
        parse_mode: "Markdown",
      });
    } catch (error) {
      await sendTelegramMessage(message.chat.id, "Не смог разобрать дату старта. Попробуй ещё раз.");
    }
    return true;
  }

  if (session.step === "end") {
    try {
      session.data.endsAt = parseFlightTimeInput(text);
      if (session.data.endsAt <= session.data.startsAt) {
        throw new Error("end before start");
      }

      session.step = "notes";
      await sendTelegramMessage(message.chat.id, "Комментарий к рейсу или `-`, если без комментария.", {
        parse_mode: "Markdown",
      });
    } catch (error) {
      await sendTelegramMessage(message.chat.id, "Не смог разобрать конец рейса. Убедись, что он позже старта.");
    }
    return true;
  }

  if (session.step === "notes") {
    session.data.notes = text === "-" ? "" : text;
    const flightRow = setCurrentFlight({
      origin: session.data.origin,
      destination: session.data.destination,
      startsAt: session.data.startsAt,
      endsAt: session.data.endsAt,
      notes: session.data.notes,
      createdByTelegramId: userRow.telegram_id,
      notificationsEnabled: true,
    });

    chatSessions.delete(message.chat.id);

    await sendTelegramMessage(
      message.chat.id,
      `Рейс сохранён.\n${formatFlightStatusMessage()}`,
      buildMiniAppButton() ? { reply_markup: buildMiniAppButton() } : {}
    );

    return true;
  }

  return false;
}

async function handleTelegramMessage(message) {
  if (!message || !message.chat || message.chat.type !== "private") {
    return;
  }

  const text = String(message.text || "").trim();
  if (!text) {
    return;
  }

  const rawUser = {
    id: message.from.id,
    username: message.from.username || "",
    first_name: message.from.first_name || "",
    last_name: message.from.last_name || "",
  };

  const userRow = upsertUserFromTelegram(rawUser, message.chat.id);

  if (await processFlightWizardStep(message, userRow)) {
    return;
  }

  const { command, args } = parseCommand(text);

  try {
    if (command === "/start") {
      await sendTelegramMessage(
        message.chat.id,
        [
          `Привет, ${userRow.display_name}.`,
          `Твоя роль: ${userRow.role}.`,
          "",
          "Команды:",
          "/status - текущий рейс",
          "/whoami - показать твой Telegram ID и роль",
          "/help - список команд",
          "/setflight - создать новый рейс (owner/admin)",
          "/setrest - перевести страницу в режим отдыха (owner/admin)",
          "/notifytest - тестовое уведомление (owner/admin)",
          "/adminstats - внутренняя сводка (admin)",
          "/setreminder <минуты> - напоминание перед концом рейса (admin)",
        ].join("\n"),
        buildMiniAppButton() ? { reply_markup: buildMiniAppButton() } : {}
      );
      return;
    }

    if (command === "/help") {
      await sendTelegramMessage(
        message.chat.id,
        [
          "/status - показать активный рейс",
          "/whoami - показать твой Telegram ID и роль",
          "/setflight - пошагово завести новый рейс",
          "/setrest - перевести страницу в режим отдыха",
          "/notifytest - прислать тестовое уведомление",
          "/cancel - отменить мастер создания рейса",
          "/adminstats - внутренняя сводка для админа",
          "/setreminder <минуты> - изменить напоминание перед концом рейса",
        ].join("\n")
      );
      return;
    }

    if (command === "/status") {
      await sendTelegramMessage(message.chat.id, formatFlightStatusMessage(), buildMiniAppButton() ? { reply_markup: buildMiniAppButton() } : {});
      return;
    }

    if (command === "/whoami") {
      await sendTelegramMessage(
        message.chat.id,
        [
          `Telegram ID: ${userRow.telegram_id}`,
          `Имя: ${userRow.display_name}`,
          `Username: ${userRow.username ? `@${userRow.username}` : "—"}`,
          `Роль: ${userRow.role}`,
          `Chat ID: ${message.chat.id}`,
        ].join("\n")
      );
      return;
    }

    if (command === "/setflight") {
      requirePrivileged(userRow);
      chatSessions.set(message.chat.id, {
        kind: "setflight",
        step: "origin",
        data: {},
      });
      await sendTelegramMessage(message.chat.id, "Введи точку отправления. Например: Doha");
      return;
    }

    if (command === "/setrest") {
      requirePrivileged(userRow);
      setRestingFlight(userRow.telegram_id);
      await sendTelegramMessage(message.chat.id, "Страница переведена в режим отдыха. Игра отключена.");
      return;
    }

    if (command === "/notifytest") {
      requirePrivileged(userRow);
      await sendTelegramMessage(message.chat.id, "Тестовое уведомление: бот и личный чат работают.");
      return;
    }

    if (command === "/adminstats") {
      requireAdmin(userRow);

      const usersCount = db.prepare("SELECT COUNT(*) AS count FROM users").get().count;
      const flightsCount = db.prepare("SELECT COUNT(*) AS count FROM flights").get().count;
      const attemptsCount = db.prepare("SELECT COUNT(*) AS count FROM attempts").get().count;
      const reminderMinutes = getSetting("reminder_before_end_minutes", String(DEFAULT_REMINDER_BEFORE_END_MINUTES));

      await sendTelegramMessage(
        message.chat.id,
        [
          "Внутренняя сводка:",
          `Пользователи: ${usersCount}`,
          `Рейсы: ${flightsCount}`,
          `Попытки игры: ${attemptsCount}`,
          `Напоминание до конца рейса: ${reminderMinutes} мин`,
        ].join("\n")
      );
      return;
    }

    if (command === "/setreminder") {
      requireAdmin(userRow);
      const minutes = Number.parseInt(args[0] || "", 10);
      if (!Number.isFinite(minutes) || minutes < 1 || minutes > 720) {
        await sendTelegramMessage(message.chat.id, "Использование: /setreminder 30");
        return;
      }

      setSettingStmt.run("reminder_before_end_minutes", String(minutes));
      const currentFlight = getCurrentFlightRow();
      if (currentFlight && currentFlight.notifications_enabled) {
        scheduleNotificationsForFlight(currentFlight);
      }

      await sendTelegramMessage(message.chat.id, `Напоминание перед концом рейса обновлено: ${minutes} минут.`);
      return;
    }

    if (command === "/cancel") {
      if (chatSessions.has(message.chat.id)) {
        chatSessions.delete(message.chat.id);
        await sendTelegramMessage(message.chat.id, "Текущая операция отменена.");
      } else {
        await sendTelegramMessage(message.chat.id, "Активных операций нет.");
      }
      return;
    }

    await sendTelegramMessage(message.chat.id, "Неизвестная команда. Отправь /help.");
  } catch (error) {
    await sendTelegramMessage(message.chat.id, `Ошибка: ${error.message}`);
  }
}

async function pollTelegramLoop() {
  if (!TELEGRAM_BOT_ENABLED) {
    console.warn("[bot] Telegram bot transport is disabled by DISABLE_TELEGRAM_BOT=1.");
    return;
  }

  if (!BOT_TOKEN) {
    console.warn("[bot] TELEGRAM_BOT_TOKEN is not configured. Bot polling is disabled.");
    return;
  }

  while (true) {
    try {
      const updates = await telegramApi("getUpdates", {
        offset: updateOffset,
        timeout: 25,
        allowed_updates: ["message"],
      });

      for (const update of updates) {
        updateOffset = update.update_id + 1;
        setSettingStmt.run("bot_update_offset", String(updateOffset));

        if (update.message) {
          await handleTelegramMessage(update.message);
        }
      }
    } catch (error) {
      console.error("[bot] polling error:", error.message);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

async function dispatchDueNotifications() {
  if (!BOT_TOKEN || !TELEGRAM_BOT_ENABLED) {
    return;
  }

  const dueNotifications = selectDueNotificationsStmt.all(nowTs());
  for (const notification of dueNotifications) {
    try {
      await sendTelegramMessage(
        notification.chat_id,
        buildNotificationText(notification),
        buildMiniAppButton() ? { reply_markup: buildMiniAppButton() } : {}
      );
      markNotificationSentStmt.run(nowTs(), notification.id);
    } catch (error) {
      console.error("[notify] failed to send notification:", error.message);
    }
  }
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk.toString("utf8");
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body is too large"));
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

function sendFile(response, filePath, contentType) {
  if (!fs.existsSync(filePath)) {
    sendJson(response, 404, { ok: false, error: "Not found" });
    return;
  }

  response.writeHead(200, {
    "content-type": contentType,
  });
  response.end(fs.readFileSync(filePath));
}

function requireManager(userRow) {
  if (!userRow || (userRow.role !== "owner" && userRow.role !== "admin")) {
    throw new Error("Owner or admin role is required");
  }
}

const server = http.createServer(async (request, response) => {
  try {
    const requestUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);

    if (request.method === "GET" && requestUrl.pathname === "/") {
      sendFile(response, path.join(__dirname, "index.html"), "text/html; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/style.css") {
      sendFile(response, path.join(__dirname, "style.css"), "text/css; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/script.js") {
      sendFile(response, path.join(__dirname, "script.js"), "application/javascript; charset=utf-8");
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/health") {
      sendJson(response, 200, { ok: true, now: nowTs() });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/bootstrap") {
      const body = JSON.parse((await readRequestBody(request)) || "{}");
      let userRow = null;

      if (body.initData) {
        const rawUser = parseTelegramInitData(body.initData);
        userRow = upsertUserFromTelegram(rawUser, body.chatId || null);
      }

      sendJson(response, 200, buildBootstrapPayload(userRow));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/game/score") {
      const body = JSON.parse((await readRequestBody(request)) || "{}");
      const rawUser = parseTelegramInitData(body.initData);
      const userRow = upsertUserFromTelegram(rawUser, body.chatId || null);
      const numericScore = Number.parseInt(body.score, 10);

      if (!Number.isFinite(numericScore) || numericScore < 0) {
        throw new Error("Score must be a non-negative integer");
      }

      recordScore({
        telegramId: userRow.telegram_id,
        score: numericScore,
        reason: String(body.reason || ""),
      });

      sendJson(response, 200, buildBootstrapPayload(userRow));
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/host/flight") {
      const body = JSON.parse((await readRequestBody(request)) || "{}");
      const rawUser = parseTelegramInitData(body.initData);
      const userRow = upsertUserFromTelegram(rawUser, body.chatId || null);
      requireManager(userRow);

      const flightRow = setCurrentFlight({
        origin: String(body.origin || "").trim(),
        destination: String(body.destination || "").trim(),
        startsAt: parseFlightTimeInput(body.startTime),
        endsAt: parseFlightTimeInput(body.endTime),
        notes: String(body.notes || "").trim(),
        createdByTelegramId: userRow.telegram_id,
        notificationsEnabled: body.notificationsEnabled !== false,
      });

      sendJson(response, 200, {
        ok: true,
        currentFlight: getFlightState(flightRow),
      });
      return;
    }

    if (request.method === "POST" && requestUrl.pathname === "/api/host/rest") {
      const body = JSON.parse((await readRequestBody(request)) || "{}");
      const rawUser = parseTelegramInitData(body.initData);
      const userRow = upsertUserFromTelegram(rawUser, body.chatId || null);
      requireManager(userRow);

      const flightRow = setRestingFlight(userRow.telegram_id);
      sendJson(response, 200, {
        ok: true,
        currentFlight: getFlightState(flightRow),
      });
      return;
    }

    if (request.method === "GET" && requestUrl.pathname === "/api/admin/summary") {
      const initData = requestUrl.searchParams.get("initData") || "";
      const rawUser = parseTelegramInitData(initData);
      const userRow = upsertUserFromTelegram(rawUser, null);
      requireAdmin(userRow);

      sendJson(response, 200, {
        ok: true,
        users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count,
        flights: db.prepare("SELECT COUNT(*) AS count FROM flights").get().count,
        attempts: db.prepare("SELECT COUNT(*) AS count FROM attempts").get().count,
        reminderBeforeEndMinutes: Number.parseInt(getSetting("reminder_before_end_minutes", String(DEFAULT_REMINDER_BEFORE_END_MINUTES)), 10),
      });
      return;
    }

    sendJson(response, 404, { ok: false, error: "Not found" });
  } catch (error) {
    console.error("[http]", error);
    sendJson(response, 400, {
      ok: false,
      error: error.message || "Unexpected error",
    });
  }
});

server.listen(PORT, () => {
  console.log(`[server] listening on http://localhost:${PORT}`);
});

setTelegramMenuButton();
pollTelegramLoop();
setInterval(() => {
  dispatchDueNotifications().catch((error) => {
    console.error("[notify]", error);
  });
}, 15_000);
