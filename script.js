const DEFAULT_FLIGHT = {
  id: "doha-istanbul-2026-03-18",
  status: "flying",
  startTime: "2026-03-18T00:10:00+03:00",
  endTime: "2026-03-18T23:50:00+03:00",
  from: "Doha",
  to: "Istanbul",
};

const STORAGE_KEYS = {
  leaderboard: `frog-flight:leaderboard:${DEFAULT_FLIGHT.id}`,
  routeUnlocked: `frog-flight:route:${DEFAULT_FLIGHT.id}`,
  currentPlayer: `frog-flight:player:${DEFAULT_FLIGHT.id}`,
};

const GAME_WORLD = {
  width: 420,
  height: 680,
  maxMisses: 3,
};

const refs = {
  tabButtons: Array.from(document.querySelectorAll("[data-tab-target]")),
  tabPanels: Array.from(document.querySelectorAll(".tab-panel")),
  launchBadge: document.getElementById("launchBadge"),
  launchNote: document.getElementById("launchNote"),
  statusLabel: document.getElementById("statusLabel"),
  timerWrap: document.getElementById("timerWrap"),
  flightTimer: document.getElementById("flightTimer"),
  routeText: document.getElementById("routeText"),
  routeNote: document.getElementById("routeNote"),
  currentPlayerLabel: document.getElementById("currentPlayerLabel"),
  currentPlayerNote: document.getElementById("currentPlayerNote"),
  playButton: document.getElementById("playButton"),
  flightNote: document.getElementById("flightNote"),
  leaderboardCaption: document.getElementById("leaderboardCaption"),
  podiumCards: document.getElementById("podiumCards"),
  leaderboardBody: document.getElementById("leaderboardBody"),
  profileTitle: document.getElementById("profileTitle"),
  profileText: document.getElementById("profileText"),
  registrationForm: document.getElementById("registrationForm"),
  registrationNameInput: document.getElementById("registrationNameInput"),
  profileSummary: document.getElementById("profileSummary"),
  profileName: document.getElementById("profileName"),
  profileBest: document.getElementById("profileBest"),
  profileRank: document.getElementById("profileRank"),
  profileMetaLabel: document.getElementById("profileMetaLabel"),
  profileMeta: document.getElementById("profileMeta"),
  switchProfileButton: document.getElementById("switchProfileButton"),
  profilePlayButton: document.getElementById("profilePlayButton"),
  startModal: document.getElementById("startModal"),
  closeStartModal: document.getElementById("closeStartModal"),
  cancelStartButton: document.getElementById("cancelStartButton"),
  beginGameButton: document.getElementById("beginGameButton"),
  startPlayerName: document.getElementById("startPlayerName"),
  startModalText: document.getElementById("startModalText"),
  gameOverlay: document.getElementById("gameOverlay"),
  gamePlayerName: document.getElementById("gamePlayerName"),
  gameScore: document.getElementById("gameScore"),
  gameMisses: document.getElementById("gameMisses"),
  exitGameButton: document.getElementById("exitGameButton"),
  gameCanvas: document.getElementById("gameCanvas"),
  resultModal: document.getElementById("resultModal"),
  resultTitle: document.getElementById("resultTitle"),
  resultText: document.getElementById("resultText"),
  resultScore: document.getElementById("resultScore"),
  resultBest: document.getElementById("resultBest"),
  closeResultButton: document.getElementById("closeResultButton"),
  retryButton: document.getElementById("retryButton"),
};

const ctx = refs.gameCanvas.getContext("2d");

const telegramState = {
  webApp: null,
  isMiniApp: false,
  user: null,
  listenersBound: false,
};

const uiState = {
  activeTabId: "flightPanel",
  pendingStartAfterRegistration: false,
};

const serverState = {
  enabled: false,
  loading: false,
  user: null,
  leaderboard: [],
  myBestScore: 0,
  routeUnlocked: false,
  telegramAuthEnabled: false,
};

const routeState = {
  unlocked: readRouteUnlocked(),
};

let activeFlight = { ...DEFAULT_FLIGHT };

const gameState = {
  running: false,
  playerId: "",
  playerName: "",
  score: 0,
  misses: 0,
  caughtAny: false,
  frogX: GAME_WORLD.width / 2,
  targetX: GAME_WORLD.width / 2,
  frogY: GAME_WORLD.height - 96,
  nuts: [],
  spawnAccumulator: 0,
  elapsed: 0,
  lastFrameAt: 0,
  animationFrameId: 0,
  backgroundShift: 0,
};

function getFlightRuntime(now = new Date()) {
  const start = new Date(activeFlight.startTime);
  const end = new Date(activeFlight.endTime);
  const isConfiguredFlying = activeFlight.status === "flying";
  const isActive = isConfiguredFlying && now >= start && now < end;
  const hasEnded = now >= end;

  return {
    now,
    start,
    end,
    isActive,
    hasEnded,
  };
}

function formatRemainingTime(ms) {
  const minutesLeft = Math.max(0, Math.ceil(ms / 60000));
  const hours = Math.floor(minutesLeft / 60);
  const minutes = minutesLeft % 60;
  return `${hours.toString().padStart(2, "0")}ч ${minutes.toString().padStart(2, "0")}м`;
}

function formatRecordTime(timestamp) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(timestamp));
}

function formatShortDate(timestamp) {
  return new Intl.DateTimeFormat("ru-RU", {
    dateStyle: "medium",
  }).format(new Date(timestamp));
}

function normalizeName(name) {
  return name.trim().toLocaleLowerCase("ru-RU");
}

function generateId() {
  if (window.crypto && typeof window.crypto.randomUUID === "function") {
    return window.crypto.randomUUID();
  }

  return `player-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => {
    const map = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };

    return map[char];
  });
}

function hexToRgba(hex, alpha) {
  const normalized = (hex || "").trim().replace("#", "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return `rgba(255, 255, 255, ${alpha})`;
  }

  const red = parseInt(normalized.slice(0, 2), 16);
  const green = parseInt(normalized.slice(2, 4), 16);
  const blue = parseInt(normalized.slice(4, 6), 16);
  return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
}

function adjustHexColor(hex, delta) {
  const normalized = (hex || "").trim().replace("#", "");
  if (!/^[\da-f]{6}$/i.test(normalized)) {
    return hex;
  }

  const shift = (value) => Math.max(0, Math.min(255, value + delta));
  const red = shift(parseInt(normalized.slice(0, 2), 16));
  const green = shift(parseInt(normalized.slice(2, 4), 16));
  const blue = shift(parseInt(normalized.slice(4, 6), 16));

  return `#${[red, green, blue].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function readRouteUnlocked() {
  return localStorage.getItem(STORAGE_KEYS.routeUnlocked) === "true";
}

function saveRouteUnlocked(value) {
  routeState.unlocked = value;
  localStorage.setItem(STORAGE_KEYS.routeUnlocked, value ? "true" : "false");
}

function loadLocalCurrentPlayer() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.currentPlayer);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.id !== "string" || typeof parsed.name !== "string") {
      return null;
    }

    const name = parsed.name.trim().slice(0, 20);
    if (!name) {
      return null;
    }

    return {
      id: parsed.id,
      name,
      createdAt: Number.isFinite(parsed.createdAt) ? parsed.createdAt : Date.now(),
      source: "browser",
    };
  } catch (error) {
    return null;
  }
}

function saveLocalCurrentPlayer(player) {
  if (!player) {
    localStorage.removeItem(STORAGE_KEYS.currentPlayer);
    return;
  }

  localStorage.setItem(STORAGE_KEYS.currentPlayer, JSON.stringify(player));
}

function buildTelegramPlayer(rawUser) {
  if (!rawUser || typeof rawUser.id !== "number") {
    return null;
  }

  const fullName = [rawUser.first_name, rawUser.last_name].filter(Boolean).join(" ").trim();
  const displayName = (fullName || (rawUser.username ? `@${rawUser.username}` : `Telegram ${rawUser.id}`)).slice(0, 20);

  return {
    id: `tg:${rawUser.id}`,
    name: displayName,
    createdAt: Date.now(),
    source: "telegram",
    telegramId: rawUser.id,
    username: rawUser.username || "",
  };
}

function getTelegramPlayer() {
  return telegramState.user;
}

function isTelegramAuthRequired() {
  return serverState.enabled && serverState.telegramAuthEnabled;
}

function getCurrentPlayer() {
  return serverState.user || getTelegramPlayer() || (isTelegramAuthRequired() ? null : loadLocalCurrentPlayer());
}

function isTelegramIdentityActive() {
  return Boolean(getTelegramPlayer());
}

function loadLeaderboard() {
  if (serverState.enabled) {
    return serverState.leaderboard.map((entry) => ({
      playerId: `tg:${entry.telegramId}`,
      name: entry.displayName,
      score: entry.score,
      achievedAt: entry.achievedAt,
    }));
  }

  try {
    const raw = localStorage.getItem(STORAGE_KEYS.leaderboard);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed
      .filter((item) => item && typeof item.name === "string")
      .map((item) => {
        const name = item.name.trim().slice(0, 20);
        return {
          playerId:
            typeof item.playerId === "string"
              ? item.playerId
              : item.normalizedName || `legacy:${normalizeName(item.name)}`,
          name,
          score: Number.isFinite(item.score) ? item.score : 0,
          achievedAt: Number.isFinite(item.achievedAt) ? item.achievedAt : Date.now(),
        };
      })
      .filter((item) => item.name);
  } catch (error) {
    return [];
  }
}

function saveLeaderboard(records) {
  localStorage.setItem(STORAGE_KEYS.leaderboard, JSON.stringify(records));
}

function sortLeaderboard(records) {
  return [...records].sort((left, right) => {
    if (right.score !== left.score) {
      return right.score - left.score;
    }

    if (left.achievedAt !== right.achievedAt) {
      return left.achievedAt - right.achievedAt;
    }

    return left.name.localeCompare(right.name, "ru");
  });
}

function removeLeaderboardEntry(playerId) {
  const filtered = loadLeaderboard().filter((entry) => entry.playerId !== playerId);
  saveLeaderboard(filtered);
}

function getPlayerBest(playerId) {
  if (serverState.enabled && serverState.user && playerId === serverState.user.id) {
    return serverState.myBestScore;
  }

  const entry = loadLeaderboard().find((item) => item.playerId === playerId);
  return entry ? entry.score : 0;
}

function getPlayerRank(playerId) {
  const sorted = sortLeaderboard(loadLeaderboard());
  const index = sorted.findIndex((entry) => entry.playerId === playerId);
  return index === -1 ? null : index + 1;
}

function syncPlayerNameInLeaderboard(player) {
  if (serverState.enabled) {
    return;
  }

  if (!player) {
    return;
  }

  const records = loadLeaderboard();
  const entry = records.find((item) => item.playerId === player.id);
  if (!entry || entry.name === player.name) {
    return;
  }

  entry.name = player.name;
  saveLeaderboard(records);
}

function upsertBestScore(player, score) {
  if (serverState.enabled) {
    return serverState.myBestScore;
  }

  if (!player) {
    return 0;
  }

  const records = loadLeaderboard();
  const existingIndex = records.findIndex((item) => item.playerId === player.id);

  if (score <= 0) {
    if (existingIndex !== -1 && records[existingIndex].name !== player.name) {
      records[existingIndex].name = player.name;
      saveLeaderboard(records);
    }

    return existingIndex === -1 ? 0 : records[existingIndex].score;
  }

  const nextEntry = {
    playerId: player.id,
    name: player.name,
    score,
    achievedAt: Date.now(),
  };

  if (existingIndex === -1) {
    records.push(nextEntry);
  } else if (score > records[existingIndex].score) {
    records[existingIndex] = nextEntry;
  } else if (records[existingIndex].name !== player.name) {
    records[existingIndex].name = player.name;
  }

  saveLeaderboard(records);
  const updated = loadLeaderboard().find((item) => item.playerId === player.id);
  return updated ? updated.score : score;
}

function setTelegramClosingConfirmation(enabled) {
  const webApp = telegramState.webApp;
  if (!telegramState.isMiniApp || !webApp) {
    return;
  }

  if (enabled && typeof webApp.enableClosingConfirmation === "function") {
    webApp.enableClosingConfirmation();
  }

  if (!enabled && typeof webApp.disableClosingConfirmation === "function") {
    webApp.disableClosingConfirmation();
  }
}

function triggerTelegramImpact(style) {
  telegramState.webApp?.HapticFeedback?.impactOccurred?.(style);
}

function triggerTelegramNotice(type) {
  telegramState.webApp?.HapticFeedback?.notificationOccurred?.(type);
}

function applyTelegramEnvironment() {
  const webApp = telegramState.webApp;
  if (!telegramState.isMiniApp || !webApp) {
    return;
  }

  const root = document.documentElement;
  const theme = webApp.themeParams || {};
  const insets = webApp.contentSafeAreaInset || webApp.safeAreaInset || {};

  root.style.setProperty("--tg-safe-top", `${insets.top || 0}px`);
  root.style.setProperty("--tg-safe-right", `${insets.right || 0}px`);
  root.style.setProperty("--tg-safe-bottom", `${insets.bottom || 0}px`);
  root.style.setProperty("--tg-safe-left", `${insets.left || 0}px`);

  const backgroundColor = theme.bg_color || "#86c5ff";
  const secondaryBackgroundColor = theme.secondary_bg_color || backgroundColor;
  const textColor = theme.text_color || "#17304f";
  const hintColor = theme.hint_color || "#5d728f";
  const buttonColor = theme.button_color || "#f66f42";

  root.style.setProperty("--ink", textColor);
  root.style.setProperty("--muted", hintColor);
  root.style.setProperty("--accent", buttonColor);
  root.style.setProperty("--accent-dark", adjustHexColor(buttonColor, -24));
  root.style.setProperty("--card-bg", hexToRgba(secondaryBackgroundColor, 0.82));
  root.style.setProperty("--card-border", hexToRgba(textColor, 0.12));

  document.body.style.background = [
    `radial-gradient(circle at top left, ${hexToRgba("#ffffff", 0.14)}, transparent 36%)`,
    `linear-gradient(180deg, ${backgroundColor} 0%, ${secondaryBackgroundColor} 100%)`,
  ].join(", ");
}

function renderLaunchContext() {
  const player = getCurrentPlayer();
  document.body.classList.toggle("is-telegram", telegramState.isMiniApp);

  if (telegramState.isMiniApp) {
    refs.launchBadge.textContent = "Telegram Mini App";
    refs.launchNote.textContent = player
      ? `Авторизация идёт через Telegram как «${player.name}» (${roleLabel(player.role || "player")}). Для общего рейтинга используется backend.`
      : "Mini App открыт внутри Telegram, но объект пользователя не передан. Для безопасности оставлен браузерный fallback.";
    return;
  }

  refs.launchBadge.textContent = "Browser Preview";
  refs.launchNote.textContent = isTelegramAuthRequired()
    ? "Сервер ждёт авторизацию через Telegram Mini App. В браузере без Telegram можно только посмотреть интерфейс."
    : "Страницу можно тестировать как обычный сайт, а внутри Telegram профиль будет браться из Mini App.";
}

function initializeTelegramMiniApp() {
  const webApp = window.Telegram?.WebApp;
  if (!webApp) {
    renderLaunchContext();
    return;
  }

  telegramState.webApp = webApp;
  telegramState.isMiniApp = Boolean(webApp.initData || webApp.initDataUnsafe);
  telegramState.user = buildTelegramPlayer(webApp.initDataUnsafe?.user);

  if (!telegramState.isMiniApp) {
    renderLaunchContext();
    return;
  }

  webApp.ready?.();
  webApp.expand?.();
  webApp.disableVerticalSwipes?.();

  try {
    webApp.setHeaderColor?.("secondary_bg_color");
  } catch (error) {
    // Optional Mini App capability.
  }

  try {
    webApp.setBackgroundColor?.(webApp.themeParams?.bg_color || "#86c5ff");
  } catch (error) {
    // Optional Mini App capability.
  }

  if (!telegramState.listenersBound) {
    webApp.onEvent?.("themeChanged", handleTelegramEnvironmentChange);
    webApp.onEvent?.("viewportChanged", handleTelegramEnvironmentChange);
    webApp.onEvent?.("safeAreaChanged", handleTelegramEnvironmentChange);
    webApp.onEvent?.("contentSafeAreaChanged", handleTelegramEnvironmentChange);
    webApp.BackButton?.onClick?.(handleTelegramBackButton);
    webApp.MainButton?.onClick?.(handleTelegramMainButtonClick);
    telegramState.listenersBound = true;
  }

  applyTelegramEnvironment();
  renderLaunchContext();
}

function roleLabel(role) {
  if (role === "owner") {
    return "Хозяйка";
  }

  if (role === "admin") {
    return "Админ";
  }

  return "Игрок";
}

function mapServerUser(user) {
  if (!user) {
    return null;
  }

  return {
    id: `tg:${user.telegramId}`,
    name: user.displayName,
    createdAt: Date.now(),
    source: "telegram",
    telegramId: user.telegramId,
    username: user.username || "",
    role: user.role || "player",
  };
}

function applyServerBootstrap(data) {
  if (!data || !data.ok) {
    return;
  }

  serverState.enabled = Boolean(data.serverMode);
  serverState.telegramAuthEnabled = Boolean(data.telegramAuthEnabled);
  serverState.user = mapServerUser(data.user);
  serverState.leaderboard = Array.isArray(data.leaderboard) ? data.leaderboard : [];
  serverState.myBestScore = Number.isFinite(data.myBestScore) ? data.myBestScore : 0;
  serverState.routeUnlocked = Boolean(data.routeUnlocked);
  routeState.unlocked = serverState.routeUnlocked;

  if (data.currentFlight && data.currentFlight.id) {
    activeFlight = {
      id: String(data.currentFlight.id),
      status: data.currentFlight.status || "resting",
      startTime: data.currentFlight.startTime,
      endTime: data.currentFlight.endTime,
      from: data.currentFlight.from || "",
      to: data.currentFlight.to || "",
      notes: data.currentFlight.notes || "",
    };
    return;
  }

  activeFlight = {
    ...DEFAULT_FLIGHT,
    id: "rest-mode",
    status: "resting",
    startTime: new Date().toISOString(),
    endTime: new Date().toISOString(),
    from: "",
    to: "",
    notes: "",
  };
}

async function postJson(url, payload) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload || {}),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  return response.json();
}

async function bootstrapFromServer() {
  if (serverState.loading) {
    return;
  }

  serverState.loading = true;

  try {
    const initData = telegramState.webApp?.initData || "";
    const payload = await postJson("/api/bootstrap", {
      initData,
    });
    applyServerBootstrap(payload);
  } catch (error) {
    serverState.enabled = false;
  } finally {
    serverState.loading = false;
    renderAll();
  }
}

async function submitScoreToServer(score, reason) {
  const initData = telegramState.webApp?.initData || "";
  if (!serverState.enabled || !initData) {
    throw new Error("Server mode is unavailable");
  }

  const payload = await postJson("/api/game/score", {
    initData,
    score,
    reason,
  });

  applyServerBootstrap(payload);
}

function handleTelegramEnvironmentChange() {
  applyTelegramEnvironment();
  renderAll();
}

function syncTelegramChrome() {
  const webApp = telegramState.webApp;
  if (!telegramState.isMiniApp || !webApp) {
    return;
  }

  const hasOverlay = !refs.startModal.hidden || !refs.resultModal.hidden || !refs.gameOverlay.hidden;
  const showBackButton = hasOverlay || uiState.activeTabId !== "flightPanel";

  if (showBackButton) {
    webApp.BackButton?.show?.();
  } else {
    webApp.BackButton?.hide?.();
  }

  const runtime = getFlightRuntime();
  const player = getCurrentPlayer();
  const showMainButton = !hasOverlay && uiState.activeTabId === "flightPanel" && runtime.isActive;

  if (!showMainButton) {
    webApp.MainButton?.hide?.();
    return;
  }

  webApp.MainButton?.setText?.(player ? "Играть" : "Открыть профиль");
  webApp.MainButton?.show?.();
  webApp.MainButton?.enable?.();
}

function handleTelegramBackButton() {
  if (!refs.resultModal.hidden) {
    closeResultModal();
    return;
  }

  if (!refs.startModal.hidden) {
    closeStartModal();
    return;
  }

  if (gameState.running) {
    endGame("Игра остановлена игроком.");
    return;
  }

  if (uiState.activeTabId !== "flightPanel") {
    switchTab("flightPanel");
    return;
  }

  telegramState.webApp?.close?.();
}

function handleTelegramMainButtonClick() {
  handlePrimaryAction();
}

function switchTab(tabId) {
  uiState.activeTabId = tabId;

  refs.tabButtons.forEach((button) => {
    const isActive = button.dataset.tabTarget === tabId;
    button.classList.toggle("is-active", isActive);
  });

  refs.tabPanels.forEach((panel) => {
    const isActive = panel.id === tabId;
    panel.hidden = !isActive;
    panel.classList.toggle("is-active", isActive);
  });

  syncTelegramChrome();
}

function focusRegistrationInput() {
  window.setTimeout(() => refs.registrationNameInput.focus(), 0);
}

function requestProfileRegistrationForStart() {
  uiState.pendingStartAfterRegistration = true;
  switchTab("profilePanel");

  if (!isTelegramIdentityActive() && !isTelegramAuthRequired()) {
    focusRegistrationInput();
  }
}

function renderRoute() {
  if (routeState.unlocked) {
    refs.routeText.textContent = `${activeFlight.from} → ${activeFlight.to}`;
    refs.routeNote.textContent = "Маршрут уже открыт. Можно продолжать соревноваться за лучший результат.";
    return;
  }

  refs.routeText.textContent = "Маршрут скрыт";
  refs.routeNote.textContent = "Поймай один объект в игре, чтобы открыть направление.";
}

function renderCurrentPlayerCard() {
  const player = getCurrentPlayer();
  if (!player) {
    refs.currentPlayerLabel.textContent = isTelegramAuthRequired() ? "Нужен Telegram-профиль" : "Профиль не создан";
    refs.currentPlayerNote.textContent = isTelegramAuthRequired()
      ? "Эта версия игры привязывает игрока к Telegram ID. Открой Mini App внутри Telegram."
      : "Открой вкладку «Профиль», чтобы зарегистрировать игрока.";
    return;
  }

  const best = getPlayerBest(player.id);
  const rank = getPlayerRank(player.id);
  refs.currentPlayerLabel.textContent = player.name;

  if (player.source === "telegram") {
    const username = player.username ? ` (@${player.username})` : "";
    refs.currentPlayerNote.textContent =
      best > 0 && rank
        ? `Профиль получен из Telegram${username}. Лучший результат: ${best}, место в таблице: #${rank}.`
        : `Профиль получен из Telegram${username}. Имя внутри Mini App меняется только через аккаунт Telegram.`;
    return;
  }

  if (best > 0 && rank) {
    refs.currentPlayerNote.textContent = `Лучший результат: ${best}. Текущее место в рейтинге: #${rank}.`;
  } else {
    refs.currentPlayerNote.textContent = "Профиль готов. Можно начинать игру и ставить первый рекорд.";
  }
}

function renderLeaderboard() {
  const currentPlayer = getCurrentPlayer();
  const records = sortLeaderboard(loadLeaderboard());
  const topThree = [records[0], records[1], records[2]];

  refs.podiumCards.innerHTML = topThree
    .map((entry, index) => {
      const place = index + 1;
      const score = entry ? `${entry.score} очк.` : "—";
      const isCurrent = Boolean(currentPlayer && entry && entry.playerId === currentPlayer.id);
      const badge = isCurrent ? '<span class="player-badge">Вы</span>' : "";
      const name = entry ? `${escapeHtml(entry.name)}${badge}` : "Свободно";
      const date = entry ? formatRecordTime(entry.achievedAt) : "Ждём результат";

      return `
        <article class="podium-card podium-card--${place}">
          <div>
            <span class="podium-place">Топ ${place}</span>
            <h3 class="podium-name">${name}</h3>
          </div>
          <div>
            <p class="podium-score">${score}</p>
            <p class="section-note">${date}</p>
          </div>
        </article>
      `;
    })
    .join("");

  if (records.length === 0) {
    refs.leaderboardBody.innerHTML = `
      <tr>
        <td class="table-empty" colspan="4">Пока нет результатов. Первый игрок задаст планку.</td>
      </tr>
    `;
    return;
  }

  refs.leaderboardBody.innerHTML = records
    .map((entry, index) => {
      const isCurrent = Boolean(currentPlayer && entry.playerId === currentPlayer.id);
      const badge = isCurrent ? '<span class="player-badge">Вы</span>' : "";

      return `
        <tr class="${isCurrent ? "is-current" : ""}">
          <td>${index + 1}</td>
          <td>${escapeHtml(entry.name)}${badge}</td>
          <td>${entry.score}</td>
          <td>${formatRecordTime(entry.achievedAt)}</td>
        </tr>
      `;
    })
    .join("");
}

function renderProfilePanel() {
  const runtime = getFlightRuntime();
  const player = getCurrentPlayer();

  if (player && player.source === "telegram") {
    const best = getPlayerBest(player.id);
    const rank = getPlayerRank(player.id);

    refs.profileTitle.textContent = "Профиль Telegram";
    refs.profileText.textContent = serverState.enabled
      ? "Игрок привязан к Telegram ID. Результаты, маршрут и рейтинг этого рейса сохраняются на сервере."
      : "Игрок авторизован через Telegram Mini App. Для общего рейтинга нужен подключённый backend.";
    refs.registrationForm.hidden = true;
    refs.profileSummary.hidden = false;
    refs.profileName.textContent = player.name;
    refs.profileBest.textContent = String(best);
    refs.profileRank.textContent = rank ? `#${rank}` : "—";
    refs.profileMetaLabel.textContent = "Роль";
    refs.profileMeta.textContent = roleLabel(player.role || "player");
    refs.switchProfileButton.hidden = true;
    refs.profilePlayButton.hidden = false;
    refs.profilePlayButton.disabled = !runtime.isActive;
    refs.profilePlayButton.textContent = runtime.isActive ? "Играть" : "Рейс недоступен";
    return;
  }

  if (isTelegramAuthRequired()) {
    refs.profileTitle.textContent = "Вход только через Telegram";
    refs.profileText.textContent =
      "Игрок и рейтинг привязываются к Telegram ID на сервере. Открой страницу как Mini App через бота, тогда профиль подтянется автоматически.";
    refs.registrationForm.hidden = true;
    refs.profileSummary.hidden = true;
    refs.switchProfileButton.hidden = true;
    refs.profilePlayButton.hidden = true;
    return;
  }

  if (!player) {
    refs.profileTitle.textContent = "Создай профиль игрока";
    refs.profileText.textContent =
      "Профиль нужен, чтобы один браузер не занимал весь рейтинг через постоянную смену имени.";
    refs.registrationForm.hidden = false;
    refs.profileSummary.hidden = true;
    refs.switchProfileButton.hidden = false;
    return;
  }

  const best = getPlayerBest(player.id);
  const rank = getPlayerRank(player.id);

  refs.profileTitle.textContent = "Профиль зарегистрирован";
  refs.profileText.textContent =
    "Все новые результаты будут записываться только за этим профилем, пока ты сам его не сменишь.";
  refs.registrationForm.hidden = true;
  refs.profileSummary.hidden = false;
  refs.profileName.textContent = player.name;
  refs.profileBest.textContent = String(best);
  refs.profileRank.textContent = rank ? `#${rank}` : "—";
  refs.profileMetaLabel.textContent = "Профиль создан";
  refs.profileMeta.textContent = formatShortDate(player.createdAt);
  refs.switchProfileButton.hidden = false;
  refs.profilePlayButton.hidden = false;
  refs.profilePlayButton.disabled = !runtime.isActive;
  refs.profilePlayButton.textContent = runtime.isActive ? "Играть" : "Рейс недоступен";
}

function renderFlightState() {
  const runtime = getFlightRuntime();
  const player = getCurrentPlayer();
  const requiresTelegram = isTelegramAuthRequired() && !player;

  if (runtime.isActive) {
    refs.statusLabel.textContent = "В полёте ✈️";
    refs.timerWrap.hidden = false;
    refs.flightTimer.textContent = formatRemainingTime(runtime.end - runtime.now);
    refs.playButton.disabled = requiresTelegram;
    refs.playButton.textContent = requiresTelegram ? "Нужен Telegram" : player ? "Играть" : "Открыть профиль";
    refs.flightNote.textContent = requiresTelegram
      ? "Рейс активен, но эта версия принимает игроков только через Telegram Mini App."
      : player
        ? `Рейс активен. Сейчас играет «${player.name}».`
        : "Рейс активен, но перед стартом нужно создать профиль или открыть Mini App внутри Telegram.";
    refs.leaderboardCaption.textContent = serverState.enabled
      ? "Общий рейтинг рейса хранится на сервере. При равенстве выше тот, кто поставил рекорд раньше."
      : "При равенстве выше тот, кто достиг результата раньше. Для глобального античита нужен backend.";
  } else if (runtime.hasEnded) {
    refs.statusLabel.textContent = "Отдыхает 💤";
    refs.timerWrap.hidden = true;
    refs.playButton.disabled = true;
    refs.playButton.textContent = "Рейс завершён";
    refs.flightNote.textContent = "Игра отключена: рейс закончился, ниже доступен финальный рейтинг.";
    refs.leaderboardCaption.textContent =
      "Финальный рейтинг рейса. При равенстве выше тот, кто поставил рекорд раньше.";
  } else {
    refs.statusLabel.textContent = "Отдыхает 💤";
    refs.timerWrap.hidden = true;
    refs.playButton.disabled = true;
    refs.playButton.textContent = "Игра ещё не открыта";
    refs.flightNote.textContent = "Рейс ещё не начался. Профиль можно подготовить заранее.";
    refs.leaderboardCaption.textContent = "Рейтинг пока пуст, но игроки появятся здесь после первых игр.";
  }

  renderRoute();
  renderCurrentPlayerCard();
}

function renderAll() {
  const currentPlayer = getCurrentPlayer();
  syncPlayerNameInLeaderboard(currentPlayer);
  renderLaunchContext();
  renderFlightState();
  renderLeaderboard();
  renderProfilePanel();
  syncTelegramChrome();
}

function openStartModal() {
  if (!getFlightRuntime().isActive) {
    renderFlightState();
    return;
  }

  const player = getCurrentPlayer();
  if (!player) {
    requestProfileRegistrationForStart();
    return;
  }

  const best = getPlayerBest(player.id);
  refs.startPlayerName.textContent = player.name;

  if (player.source === "telegram") {
    refs.startModalText.textContent =
      best > 0
        ? `Ты играешь как Telegram-пользователь «${player.name}». Текущий рекорд: ${best}.`
        : "Ты играешь под Telegram-профилем. Маршрут откроется после первого пойманного орешка.";
  } else {
    refs.startModalText.textContent =
      best > 0
        ? `Твой текущий рекорд: ${best}. Маршрут откроется после первого пойманного орешка, если он ещё скрыт.`
        : "Маршрут откроется после первого пойманного орешка. Чтобы сменить игрока, перейди во вкладку «Профиль».";
  }

  refs.startModal.hidden = false;
  syncTelegramChrome();
}

function closeStartModal() {
  refs.startModal.hidden = true;
  syncTelegramChrome();
}

function openResultModal() {
  refs.resultModal.hidden = false;
  syncTelegramChrome();
}

function closeResultModal() {
  refs.resultModal.hidden = true;
  syncTelegramChrome();
}

function handleRegisterSubmit(event) {
  event.preventDefault();

  if (isTelegramIdentityActive() || isTelegramAuthRequired()) {
    return;
  }

  const name = refs.registrationNameInput.value.trim().slice(0, 20);
  if (!name) {
    refs.registrationNameInput.focus();
    return;
  }

  saveLocalCurrentPlayer({
    id: generateId(),
    name,
    createdAt: Date.now(),
    source: "browser",
  });

  refs.registrationNameInput.value = "";
  renderAll();

  if (uiState.pendingStartAfterRegistration && getFlightRuntime().isActive) {
    uiState.pendingStartAfterRegistration = false;
    switchTab("flightPanel");
    openStartModal();
    return;
  }

  uiState.pendingStartAfterRegistration = false;
  switchTab("profilePanel");
}

function handleSwitchProfile() {
  const player = getCurrentPlayer();
  if (!player || player.source === "telegram") {
    return;
  }

  const best = getPlayerBest(player.id);
  const message =
    best > 0
      ? `Сменить игрока? Профиль «${player.name}» и его локальный рекорд будут удалены из этого браузера.`
      : `Сменить игрока? Профиль «${player.name}» будет удалён из этого браузера.`;

  if (!window.confirm(message)) {
    return;
  }

  removeLeaderboardEntry(player.id);
  saveLocalCurrentPlayer(null);
  uiState.pendingStartAfterRegistration = false;
  closeStartModal();
  closeResultModal();
  renderAll();
  switchTab("profilePanel");
  focusRegistrationInput();
}

function handlePrimaryAction() {
  if (!getFlightRuntime().isActive) {
    renderFlightState();
    return;
  }

  const player = getCurrentPlayer();
  if (!player) {
    requestProfileRegistrationForStart();
    return;
  }

  switchTab("flightPanel");
  openStartModal();
}

function beginGame() {
  if (!getFlightRuntime().isActive) {
    renderFlightState();
    closeStartModal();
    return;
  }

  const player = getCurrentPlayer();
  if (!player) {
    closeStartModal();
    requestProfileRegistrationForStart();
    return;
  }

  closeStartModal();
  closeResultModal();
  setTelegramClosingConfirmation(true);
  triggerTelegramImpact("medium");

  gameState.running = true;
  gameState.playerId = player.id;
  gameState.playerName = player.name;
  gameState.score = 0;
  gameState.misses = 0;
  gameState.caughtAny = false;
  gameState.frogX = GAME_WORLD.width / 2;
  gameState.targetX = GAME_WORLD.width / 2;
  gameState.nuts = [];
  gameState.spawnAccumulator = 0;
  gameState.elapsed = 0;
  gameState.lastFrameAt = 0;
  gameState.backgroundShift = 0;

  refs.gamePlayerName.textContent = player.name;
  refs.gameScore.textContent = "0";
  refs.gameMisses.textContent = `0 / ${GAME_WORLD.maxMisses}`;
  refs.gameOverlay.hidden = false;
  syncTelegramChrome();
  drawFrame();
  gameState.animationFrameId = requestAnimationFrame(gameLoop);
}

function endGame(reason) {
  if (!gameState.running) {
    return;
  }

  gameState.running = false;
  cancelAnimationFrame(gameState.animationFrameId);
  refs.gameOverlay.hidden = true;
  setTelegramClosingConfirmation(false);

  const player = getCurrentPlayer() || {
    id: gameState.playerId,
    name: gameState.playerName,
  };

  const finalizeResult = (bestScore) => {
    const rank = getPlayerRank(player.id);

    renderAll();
    switchTab("leadersPanel");

    refs.resultTitle.textContent = gameState.score > 0 ? "Игра окончена" : "Попробуй ещё";

    if (gameState.score > 0) {
      refs.resultText.textContent = rank
        ? `${reason} Ты собрал ${gameState.score} ${pluralizePoints(gameState.score)} и сейчас стоишь на месте #${rank}.`
        : `${reason} Ты собрал ${gameState.score} ${pluralizePoints(gameState.score)}.`;
      triggerTelegramNotice("success");
    } else if (routeState.unlocked) {
      refs.resultText.textContent = `${reason} Очков нет, но маршрут уже был открыт раньше.`;
      triggerTelegramNotice("warning");
    } else {
      refs.resultText.textContent = `${reason} Ни один орешек не пойман, поэтому маршрут остался скрытым.`;
      triggerTelegramNotice("error");
    }

    refs.resultScore.textContent = String(gameState.score);
    refs.resultBest.textContent = String(bestScore);
    refs.retryButton.hidden = !getFlightRuntime().isActive || !getCurrentPlayer();
    openResultModal();
  };

  if (serverState.enabled && telegramState.webApp?.initData) {
    submitScoreToServer(gameState.score, reason)
      .then(() => {
        finalizeResult(serverState.myBestScore);
      })
      .catch(() => {
        finalizeResult(upsertBestScore(player, gameState.score));
      });
    return;
  }

  finalizeResult(upsertBestScore(player, gameState.score));
}

function pluralizePoints(score) {
  const mod10 = score % 10;
  const mod100 = score % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return "орешек";
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return "орешка";
  }

  return "орешков";
}

function updatePointerPosition(clientX) {
  const rect = refs.gameCanvas.getBoundingClientRect();
  const relativeX = ((clientX - rect.left) / rect.width) * GAME_WORLD.width;
  gameState.targetX = clamp(relativeX, 44, GAME_WORLD.width - 44);
}

function gameLoop(timestamp) {
  if (!gameState.running) {
    return;
  }

  const runtime = getFlightRuntime();
  if (!runtime.isActive) {
    endGame("Рейс завершился.");
    return;
  }

  if (!gameState.lastFrameAt) {
    gameState.lastFrameAt = timestamp;
  }

  const delta = Math.min((timestamp - gameState.lastFrameAt) / 1000, 0.04);
  gameState.lastFrameAt = timestamp;
  gameState.elapsed += delta;
  gameState.backgroundShift += delta * 30;
  gameState.frogX += (gameState.targetX - gameState.frogX) * Math.min(1, delta * 12);

  const spawnInterval = Math.max(0.26, 0.92 - gameState.elapsed * 0.02);
  gameState.spawnAccumulator += delta;

  while (gameState.spawnAccumulator >= spawnInterval) {
    spawnNut();
    gameState.spawnAccumulator -= spawnInterval;

    if (Math.random() < Math.min(0.52, gameState.elapsed / 25)) {
      spawnNut(true);
    }
  }

  updateNuts(delta);
  drawFrame();

  if (gameState.running) {
    gameState.animationFrameId = requestAnimationFrame(gameLoop);
  }
}

function spawnNut(isExtra = false) {
  const edgePadding = 28;
  const laneWidth = GAME_WORLD.width - edgePadding * 2;
  const speed = 160 + gameState.elapsed * 11 + Math.random() * 54 + (isExtra ? 12 : 0);
  const drift = (Math.random() - 0.5) * 22;

  gameState.nuts.push({
    x: edgePadding + Math.random() * laneWidth,
    y: -24,
    radius: 15 + Math.random() * 6,
    speed,
    drift,
    wobble: Math.random() * Math.PI * 2,
    spin: (Math.random() - 0.5) * 3,
  });
}

function updateNuts(delta) {
  const frogBounds = {
    left: gameState.frogX - 48,
    right: gameState.frogX + 48,
    top: gameState.frogY - 28,
    bottom: gameState.frogY + 24,
  };

  gameState.nuts = gameState.nuts.filter((nut) => {
    if (!gameState.running) {
      return false;
    }

    nut.wobble += delta * 5;
    nut.x += Math.sin(nut.wobble) * nut.drift * delta;
    nut.y += nut.speed * delta;

    const caught =
      nut.x + nut.radius > frogBounds.left &&
      nut.x - nut.radius < frogBounds.right &&
      nut.y + nut.radius > frogBounds.top &&
      nut.y - nut.radius < frogBounds.bottom;

    if (caught) {
      gameState.score += 1;
      refs.gameScore.textContent = String(gameState.score);
      triggerTelegramImpact("light");

      if (!gameState.caughtAny) {
        gameState.caughtAny = true;
        saveRouteUnlocked(true);
        renderRoute();
        triggerTelegramNotice("success");
      }

      return false;
    }

    if (nut.y - nut.radius > GAME_WORLD.height) {
      gameState.misses += 1;
      refs.gameMisses.textContent = `${gameState.misses} / ${GAME_WORLD.maxMisses}`;

      if (gameState.misses >= GAME_WORLD.maxMisses) {
        endGame("Слишком много пропущенных орешков.");
      }

      return false;
    }

    return true;
  });
}

function drawFrame() {
  ctx.clearRect(0, 0, GAME_WORLD.width, GAME_WORLD.height);
  drawSky();
  drawClouds();
  drawNuts();
  drawGround();
  drawFrogPlane();
}

function drawSky() {
  const gradient = ctx.createLinearGradient(0, 0, 0, GAME_WORLD.height);
  gradient.addColorStop(0, "#8ad5ff");
  gradient.addColorStop(0.6, "#dff4ff");
  gradient.addColorStop(1, "#f9f7dd");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GAME_WORLD.width, GAME_WORLD.height);

  ctx.fillStyle = "rgba(255, 234, 149, 0.85)";
  ctx.beginPath();
  ctx.arc(330, 88, 46, 0, Math.PI * 2);
  ctx.fill();
}

function drawClouds() {
  const cloudOffsets = [0, 150, 300];
  const baseX = -(gameState.backgroundShift % 150);

  cloudOffsets.forEach((offset, index) => {
    drawCloudShape(baseX + offset + index * 36, 90 + index * 110, 0.92 - index * 0.18);
  });
}

function drawCloudShape(x, y, scale) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.fillStyle = "rgba(255, 255, 255, 0.85)";

  ctx.beginPath();
  ctx.arc(0, 16, 16, Math.PI * 0.5, Math.PI * 1.5);
  ctx.arc(22, 8, 20, Math.PI, Math.PI * 2);
  ctx.arc(52, 16, 16, Math.PI * 1.5, Math.PI * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawGround() {
  const gradient = ctx.createLinearGradient(0, GAME_WORLD.height - 90, 0, GAME_WORLD.height);
  gradient.addColorStop(0, "rgba(133, 205, 102, 0.7)");
  gradient.addColorStop(1, "#4ea460");
  ctx.fillStyle = gradient;
  ctx.fillRect(0, GAME_WORLD.height - 88, GAME_WORLD.width, 88);

  ctx.fillStyle = "rgba(255, 255, 255, 0.26)";
  for (let index = 0; index < 9; index += 1) {
    ctx.beginPath();
    ctx.arc(26 + index * 48, GAME_WORLD.height - 64 + (index % 2) * 6, 22, Math.PI, 0);
    ctx.fill();
  }
}

function drawNuts() {
  gameState.nuts.forEach((nut) => {
    ctx.save();
    ctx.translate(nut.x, nut.y);
    ctx.rotate(nut.spin + nut.wobble * 0.2);

    ctx.fillStyle = "#8b582b";
    ctx.beginPath();
    ctx.ellipse(0, 3, nut.radius * 0.72, nut.radius, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#5d3518";
    ctx.beginPath();
    ctx.arc(0, -nut.radius * 0.6, nut.radius * 0.5, Math.PI, 0);
    ctx.fill();

    ctx.strokeStyle = "rgba(255, 255, 255, 0.22)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(-nut.radius * 0.2, -4);
    ctx.lineTo(nut.radius * 0.18, nut.radius * 0.45);
    ctx.stroke();

    ctx.restore();
  });
}

function drawFrogPlane() {
  const x = gameState.frogX;
  const y = gameState.frogY;

  ctx.save();
  ctx.translate(x, y);

  ctx.fillStyle = "#ef6c42";
  roundedRect(ctx, -56, -18, 100, 40, 18);
  ctx.fill();

  ctx.fillStyle = "#d65831";
  ctx.beginPath();
  ctx.moveTo(-56, -18);
  ctx.lineTo(-76, 10);
  ctx.lineTo(-46, 10);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#ffd9c6";
  ctx.beginPath();
  ctx.moveTo(-8, 16);
  ctx.lineTo(42, 16);
  ctx.lineTo(22, 42);
  ctx.lineTo(-28, 42);
  ctx.closePath();
  ctx.fill();

  ctx.strokeStyle = "rgba(255, 255, 255, 0.82)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(34, 0, 14, 0, Math.PI * 2);
  ctx.stroke();

  const bladeRotation = performance.now() * 0.02;
  ctx.save();
  ctx.translate(34, 0);
  ctx.rotate(bladeRotation);
  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  roundedRect(ctx, -2.5, -18, 5, 36, 3);
  ctx.fill();
  ctx.rotate(Math.PI / 2);
  roundedRect(ctx, -2.5, -18, 5, 36, 3);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = "#64cb63";
  roundedRect(ctx, -34, -46, 54, 42, 20);
  ctx.fill();

  ctx.fillStyle = "#ebfbec";
  ctx.beginPath();
  ctx.arc(-18, -48, 10, 0, Math.PI * 2);
  ctx.arc(-2, -48, 10, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#11261a";
  ctx.beginPath();
  ctx.arc(-18, -48, 4, 0, Math.PI * 2);
  ctx.arc(-2, -48, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = "#1d5a29";
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(-10, -32, 10, 0.1 * Math.PI, 0.9 * Math.PI);
  ctx.stroke();

  ctx.fillStyle = "rgba(255, 198, 152, 0.9)";
  ctx.beginPath();
  ctx.arc(-25, -26, 4, 0, Math.PI * 2);
  ctx.arc(4, -26, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function roundedRect(context, x, y, width, height, radius) {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.lineTo(x + width - radius, y);
  context.quadraticCurveTo(x + width, y, x + width, y + radius);
  context.lineTo(x + width, y + height - radius);
  context.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  context.lineTo(x + radius, y + height);
  context.quadraticCurveTo(x, y + height, x, y + height - radius);
  context.lineTo(x, y + radius);
  context.quadraticCurveTo(x, y, x + radius, y);
  context.closePath();
}

refs.tabButtons.forEach((button) => {
  button.addEventListener("click", () => switchTab(button.dataset.tabTarget));
});

refs.playButton.addEventListener("click", handlePrimaryAction);
refs.registrationForm.addEventListener("submit", handleRegisterSubmit);
refs.switchProfileButton.addEventListener("click", handleSwitchProfile);
refs.profilePlayButton.addEventListener("click", handlePrimaryAction);
refs.closeStartModal.addEventListener("click", closeStartModal);
refs.cancelStartButton.addEventListener("click", closeStartModal);
refs.beginGameButton.addEventListener("click", beginGame);
refs.exitGameButton.addEventListener("click", () => endGame("Игра остановлена игроком."));
refs.closeResultButton.addEventListener("click", closeResultModal);
refs.retryButton.addEventListener("click", () => {
  closeResultModal();
  openStartModal();
});

refs.startModal.addEventListener("click", (event) => {
  if (event.target === refs.startModal) {
    closeStartModal();
  }
});

refs.resultModal.addEventListener("click", (event) => {
  if (event.target === refs.resultModal) {
    closeResultModal();
  }
});

["pointermove", "pointerdown"].forEach((eventName) => {
  refs.gameCanvas.addEventListener(eventName, (event) => {
    updatePointerPosition(event.clientX);
  });
});

initializeTelegramMiniApp();
switchTab(uiState.activeTabId);
drawFrame();
renderAll();
bootstrapFromServer();

window.setInterval(() => {
  renderAll();
}, 1000);

window.setInterval(() => {
  bootstrapFromServer();
}, 20000);
