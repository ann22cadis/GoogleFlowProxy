/**
 * Flow — Chrome Extension Background Service Worker
 *
 * Транспорт до Python-агента: HTTP long-poll (см. main.py).
 *
 * Почему не WebSocket: на Android система убивает MV3 Service Worker каждый
 * раз, когда пользователь уходит из браузера или просто сворачивает вкладку.
 * Постоянный сокет вместе с ним умирает, и все запросы теряются.
 *
 * Long-poll решает это сразу с двух сторон:
 *   • висящий fetch сам по себе не даёт воркеру уснуть;
 *   • если воркер всё-таки убили — задача осталась в очереди на сервере
 *     и будет выдана заново, как только воркер оживёт.
 */

const AGENT_BASE = 'http://127.0.0.1:8001';
const POLL_URL = `${AGENT_BASE}/api/ext/poll?wait=25`;
const CALLBACK_URL = `${AGENT_BASE}/api/ext/callback`;

const FLOW_URL = 'https://flow.google.com/';
const FLOW_TAB_PATTERNS = ['https://flow.google.com/*'];
const BATCHEXECUTE_BASE = 'https://flow.google.com/_/AiSandboxAngularFrontend/data/batchexecute';

// На Android вкладка тормознутая: grecaptcha после разморозки отвечает
// по 10–20 секунд. Старые 5 секунд гарантировали вечный CAPTCHA_TIMEOUT.
const CAPTCHA_TIMEOUT_MS = 35000;
const TAB_WAKE_TIMEOUT_MS = 25000;
const TOKEN_REFRESH_WAIT_MS = 25000;
// По замерам генерация идёт 6–8 с, апскейл ~10 с. Запас большой, но вместе с
// капчей (до 3 фреймов по 35 с) должен уложиться в ожидание main.py (180 с).
const FETCH_TIMEOUT_MS = 60000;

// bl/f.sid/at — служебные параметры batchexecute, которые страница
// flow.google.com сама генерирует при загрузке. Ловим их пассивно из
// её собственного трафика (см. слушатель webRequest ниже).
//
// Храним ОТДЕЛЬНО для каждого фрейма: f.sid и at привязаны к конкретной
// загрузке страницы. Если взять параметры из скрытого iframe в SillyTavern,
// а запрос отправить из настоящей вкладки Flow, Google отвечает HTTP 400.
let frameConfigs = {}; // "tabId:frameId" -> {bl, fsid, at, ts}
let batchConfigCapturedAt = null;
let state = 'off';
let manualDisconnect = false;
let metrics = {
  tokenCapturedAt: null,
  requestCount: 0,   // captcha-consuming requests only (gen image/video/upscale)
  successCount: 0,
  failedCount: 0,
  lastError: null,
};
let requestLog = [];

// ─── Инициализация ──────────────────────────────────────────
// Service Worker на Android перезапускается постоянно, и при перезапуске
// выполняется ТОЛЬКО top-level код — прежний init() по onInstalled/onStartup
// не вызывался, и состояние терялось. Теперь оно подтягивается при любом
// оживлении.

let _initPromise = null;

function ensureInit() {
  if (!_initPromise) _initPromise = doInit();
  return _initPromise;
}

async function doInit() {
  try {
    const d = await chrome.storage.local.get([
      'frameConfigs', 'batchConfigCapturedAt', 'metrics', 'manualDisconnect', 'requestLog',
    ]);
    if (d.frameConfigs) frameConfigs = { ...d.frameConfigs, ...frameConfigs };
    if (d.batchConfigCapturedAt) batchConfigCapturedAt = d.batchConfigCapturedAt;
    if (d.metrics) Object.assign(metrics, d.metrics);
    if (Array.isArray(d.requestLog)) requestLog = d.requestLog;
    manualDisconnect = !!d.manualDisconnect;
  } catch (e) {
    console.warn('[Flow] Не смогли прочитать storage:', e);
  }
  setupAlarms();
  ensureOffscreenDocument();
}

function setupAlarms() {
  // Будильники переживают смерть воркера — в отличие от setInterval,
  // который умирал вместе с ним и больше никогда не запускался.
  chrome.alarms.create('poll-watchdog', { periodInMinutes: 0.5 });
  // Раньше вкладка Flow перезагружалась каждые 30 минут ради свежего
  // Bearer-токена. Теперь это только вредит: после перезагрузки у страницы
  // новая сессия и нет reCAPTCHA. Старые будильники могли пережить обновление.
  chrome.alarms.clear('batch-config-refresh');
  chrome.alarms.clear('token-refresh');
  chrome.alarms.clear('telemetry');
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInit();
  if (alarm.name === 'poll-watchdog') {
    startPolling();
    ensureOffscreenDocument();
  }
});

chrome.runtime.onInstalled.addListener(() => { ensureInit().then(startPolling); });
chrome.runtime.onStartup.addListener(() => { ensureInit().then(startPolling); });

// Главное: старт при КАЖДОМ оживлении воркера, чем бы оно ни было вызвано.
ensureInit().then(startPolling);

// ─── Реестр живых Flow-фреймов ──────────────────────────────
// Вкладка flow.google.com на Android легко выгружается. Но captcha умеет
// выдавать любой фрейм с origin flow.google.com — в том числе скрытый iframe,
// который st_injector.js вставляет прямо во вкладку SillyTavern. Такой фрейм
// живёт ровно столько, сколько открыта вкладка, которой пользователь реально
// пользуется, поэтому он куда надёжнее отдельной вкладки Flow.

const flowFrames = new Map(); // "tabId:frameId" -> { tabId, frameId, url, ts }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'flow-frame') return;

  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId ?? 0;
  const url = port.sender?.url || '';
  if (tabId == null || !url.startsWith('https://flow.google.com/')) return;

  const key = `${tabId}:${frameId}`;
  flowFrames.set(key, { tabId, frameId, url, ts: Date.now() });
  console.log(`[Flow] Фрейм ${key} на связи`);

  port.onMessage.addListener(() => {
    const f = flowFrames.get(key);
    if (f) f.ts = Date.now();
    ensureInit().then(startPolling);
  });

  port.onDisconnect.addListener(() => flowFrames.delete(key));

  ensureInit().then(startPolling);
});

// ─── Long-poll цикл ─────────────────────────────────────────

let _pollActive = false;

async function startPolling() {
  if (_pollActive || manualDisconnect) return;
  _pollActive = true;

  let failures = 0;
  try {
    while (!manualDisconnect) {
      let jobs = [];
      try {
        const resp = await fetch(POLL_URL, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        jobs = (await resp.json()).jobs || [];
        if (state === 'off') setState('idle');
        failures = 0;
      } catch (e) {
        failures++;
        setState('off');
        // Сервер не запущен — не крутим цикл вхолостую, воркер разбудит будильник
        if (failures >= 3) break;
        await sleep(2000 * failures);
        continue;
      }

      for (const job of jobs) {
        ackJob(job.id);
        // Намеренно без await: сразу возвращаемся к поллингу, чтобы висящий
        // fetch продолжал держать воркер живым, пока задача выполняется.
        handleJob(job);
      }
    }
  } finally {
    _pollActive = false;
  }
}

function ackJob(id) {
  // Подтверждаем приём: сервер поймёт, что задача не потерялась,
  // и не выдаст её второй раз (иначе можно дважды сжечь генерацию).
  fetch(CALLBACK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, ack: true }),
  }).catch(() => {});
}

async function handleJob(job) {
  try {
    await ensureInit();
    if (job.method === 'batch_execute') {
      await handleBatchExecute(job);
    } else if (job.method === 'solve_captcha') {
      await handleSolveCaptcha(job);
    } else if (job.method === 'get_status') {
      await sendToAgent({
        id: job.id,
        result: {
          state,
          flowKeyPresent: Object.keys(frameConfigs).length > 0,
          manualDisconnect,
          tokenAge: batchConfigCapturedAt ? Date.now() - batchConfigCapturedAt : null,
          metrics,
        },
      });
    } else {
      await sendToAgent({ id: job.id, error: `UNKNOWN_METHOD: ${job.method}` });
    }
  } catch (e) {
    console.error('[Flow] Ошибка обработки задачи:', e);
    await sendToAgent({ id: job.id, error: e?.message || 'JOB_FAILED' });
  }
}

async function sendToAgent(msg) {
  // Ответ уходит обычным HTTP — он не зависит от состояния соединения
  // и доходит, даже если воркер только что перезапустился.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const resp = await fetch(CALLBACK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(msg),
      });
      if (resp.ok) return true;
    } catch {}
    await sleep(400 * (attempt + 1));
  }
  console.error('[Flow] Не смогли доставить ответ агенту:', msg.id);
  return false;
}

// ─── Токен ──────────────────────────────────────────────────

// Ловим bl/f.sid/at пассивно из трафика, который страница создаёт сама
// (первые RPC вроде nzlxg/jHPbke уходят автоматически при загрузке страницы,
// без участия пользователя). Авторизация самого запроса — обычные cookies
// сессии, они уходят сами при same-origin fetch из injected.js и здесь не
// участвуют.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    try {
      if (details.tabId == null || details.tabId < 0) return;
      const u = new URL(details.url);
      const bl = u.searchParams.get('bl');
      const fsid = u.searchParams.get('f.sid');
      const at = details.requestBody?.formData?.['at']?.[0];
      if (!bl || !fsid || !at) return;

      const now = Date.now();
      frameConfigs[frameKey(details)] = { bl, fsid, at, ts: now };
      batchConfigCapturedAt = now;
      metrics.tokenCapturedAt = now;
      persistFrameConfigs();
    } catch (e) {
      console.warn('[Flow] Не смогли разобрать batchexecute-запрос:', e);
    }
  },
  { urls: [`${BATCHEXECUTE_BASE}*`] },
  ['requestBody'],
);

// Фрейм загрузил новую страницу — его f.sid/at больше не действуют.
// (Переходы внутри приложения через history API сюда не попадают и сессию
// не меняют.)
chrome.webNavigation.onCommitted.addListener((details) => {
  const key = frameKey(details);
  if (frameConfigs[key]) {
    delete frameConfigs[key];
    persistFrameConfigs();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  let changed = false;
  for (const key of Object.keys(frameConfigs)) {
    if (key.startsWith(`${tabId}:`)) {
      delete frameConfigs[key];
      changed = true;
    }
  }
  if (changed) persistFrameConfigs();
});

// После перезапуска браузера id вкладок выдаются заново и могут совпасть со
// старыми — сохранённые параметры тогда достались бы чужой вкладке.
chrome.runtime.onStartup.addListener(async () => {
  await ensureInit();
  frameConfigs = {};
  persistFrameConfigs();
});

function frameKey({ tabId, frameId }) {
  return `${tabId}:${frameId ?? 0}`;
}

function persistFrameConfigs() {
  chrome.storage.local.set({ frameConfigs, batchConfigCapturedAt, metrics }).catch(() => {});
}

// bl/f.sid/at ловятся пассивно из трафика страницы, поэтому единственный
// надёжный способ получить их для фрейма — заставить его загрузиться заново.
// Возвращает цель, для которой параметры появились, или null.
async function refreshFrameConfig(preferred) {
  let target = preferred;

  if (!target) {
    const targets = await findCaptchaTargets();
    target = targets.find((t) => t.frameId === 0) || targets[0];
  }

  if (!target) {
    if (!(await openFlowTab())) return null;
    const targets = await findCaptchaTargets();
    target = targets.find((t) => t.frameId === 0) || targets[0];
    if (!target) return null;
  } else if (target.frameId === 0) {
    try {
      await chrome.tabs.reload(target.tabId);
    } catch {
      return null;
    }
  } else {
    // Скрытый iframe живёт внутри страницы SillyTavern: обновляем только его,
    // иначе у человека перезагрузится Таверна вместе с чатом.
    if (!(await reloadFrame(target))) return null;
  }

  const key = frameKey(target);
  const deadline = Date.now() + TOKEN_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    if (frameConfigs[key]) {
      console.log(`[Flow] bl/f.sid/at для фрейма ${key} получены`);
      return target;
    }
    await sleep(1000);
  }
  console.warn(`[Flow] Фрейм ${key} не прислал bl/f.sid/at`);
  return null;
}

// ─── Поиск вкладок и фреймов для капчи ──────────────────────

async function findCaptchaTargets() {
  const targets = [];
  const seen = new Set();
  const push = (t) => {
    const k = `${t.tabId}:${t.frameId}`;
    if (!seen.has(k)) { seen.add(k); targets.push(t); }
  };

  // Порядок здесь принципиален. reCAPTCHA Enterprise оценивает контекст, в
  // котором её вызвали, и скрытый iframe размером с пиксель — классический
  // признак бота: Google отвечает PUBLIC_ERROR_UNUSUAL_ACTIVITY и запрос
  // падает с 403 "reCAPTCHA evaluation failed". Поэтому настоящая вкладка
  // Flow идёт первой всегда, а iframe остаётся аварийным вариантом.

  // 1. Настоящие вкладки flow.google.com: активная -> живая -> выгруженная
  const tabs = await chrome.tabs.query({ url: FLOW_TAB_PATTERNS }).catch(() => []);
  const rank = (t) => (t.active ? -1 : 0) + (t.discarded ? 2 : 0);
  tabs.sort((a, b) => rank(a) - rank(b));
  for (const t of tabs) {
    if (t.id != null) push({ tabId: t.id, frameId: 0, kind: 'вкладка Flow', discarded: !!t.discarded });
  }

  // 2. Верхнеуровневые фреймы, сообщившие о себе по порту
  for (const f of [...flowFrames.values()].sort((a, b) => b.ts - a.ts)) {
    if (f.frameId === 0) push({ ...f, kind: 'вкладка Flow' });
  }

  // 3. Только теперь — скрытые iframe (например, во вкладке SillyTavern)
  for (const f of [...flowFrames.values()].sort((a, b) => b.ts - a.ts)) {
    if (f.frameId !== 0) push({ ...f, kind: 'скрытый iframe' });
  }

  if (chrome.webNavigation) {
    const all = await chrome.tabs.query({}).catch(() => []);
    for (const t of all) {
      if (t.id == null) continue;
      const frames = await chrome.webNavigation.getAllFrames({ tabId: t.id }).catch(() => null);
      if (!frames) continue;
      for (const fr of frames) {
        if (fr.frameId !== 0 && fr.url?.startsWith('https://flow.google.com/')) {
          push({ tabId: t.id, frameId: fr.frameId, kind: 'скрытый iframe' });
        }
      }
    }
  }

  return targets;
}

// Обновляет один фрейм, не трогая страницу, в которой он живёт.
async function reloadFrame({ tabId, frameId }) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => location.reload(),
    });
    return true;
  } catch (e) {
    console.warn(`[Flow] Не смогли обновить фрейм ${tabId}:${frameId} — ${e?.message || e}`);
    return false;
  }
}

async function wakeTab({ tabId, frameId }) {
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    return false;
  }
  // Android выгружает фоновые вкладки: скрипт в них не отвечает,
  // пока вкладку не перезагрузить.
  if (tab.discarded || tab.status === 'unloaded') {
    // Выгруженная вкладка со скрытым iframe — это почти всегда SillyTavern.
    // Перезагрузить её значит увести человека с чата, поэтому просто
    // пропускаем эту цель: следующей в списке идёт настоящая вкладка Flow.
    if (frameId !== 0) {
      console.log(`[Flow] Вкладка ${tabId} со скрытым iframe выгружена — не трогаем её`);
      return false;
    }
    console.log(`[Flow] Вкладка ${tabId} была выгружена системой — поднимаем`);
    try {
      await chrome.tabs.reload(tabId);
    } catch {
      return false;
    }
    const ok = await waitForTabComplete(tabId, TAB_WAKE_TIMEOUT_MS);
    if (!ok) return false;
    await sleep(2500); // дать grecaptcha подгрузиться
  }
  return true;
}

async function waitForTabComplete(tabId, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab.status === 'complete' && !tab.discarded) return true;
    } catch {
      return false;
    }
    await sleep(500);
  }
  return false;
}

let _openingFlowTab = false;

async function openFlowTab() {
  if (_openingFlowTab) return false;

  // Флаг в памяти сбрасывается вместе с воркером, поэтому дублируем его
  // в storage — иначе на Android расширение наплодит десяток вкладок Flow.
  const now = Date.now();
  const { lastFlowTabOpen = 0 } = await chrome.storage.local.get('lastFlowTabOpen');
  if (now - lastFlowTabOpen < 30000) return false;

  _openingFlowTab = true;
  await chrome.storage.local.set({ lastFlowTabOpen: now });
  try {
    console.log('[Flow] Вкладки Flow нет — открываем в фоне');
    await chrome.tabs.create({ url: FLOW_URL, active: false });
    const deadline = Date.now() + TAB_WAKE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(1500);
      const targets = await findCaptchaTargets();
      if (targets.length) return true;
    }
    return false;
  } catch (e) {
    console.error('[Flow] Не смогли открыть вкладку Flow:', e);
    return false;
  } finally {
    _openingFlowTab = false;
  }
}

// ─── Капча ──────────────────────────────────────────────────

async function requestCaptchaFromFrame(target, requestId, pageAction) {
  const { tabId, frameId } = target;
  const message = { type: 'GET_CAPTCHA', requestId, pageAction };
  const options = frameId != null ? { frameId } : undefined;

  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    await chrome.scripting.executeScript({
      target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId },
      files: ['keepalive.js', 'content.js'],
    });
    await sleep(500);
    return await chrome.tabs.sendMessage(tabId, message, options);
  }
}

function withTimeout(promise, ms, errName) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(errName)), ms)),
  ]);
}

async function solveCaptcha(requestId, captchaAction, preferred = null) {
  await ensureInit();

  let targets = await findCaptchaTargets();
  if (preferred) {
    // Токен берём с той же страницы, из которой потом уйдёт запрос
    targets = [preferred, ...targets.filter((t) => frameKey(t) !== frameKey(preferred))];
  }
  if (!targets.length) {
    const opened = await openFlowTab();
    if (!opened) return { error: 'NO_FLOW_TAB' };
    targets = await findCaptchaTargets();
    if (!targets.length) return { error: 'NO_FLOW_TAB' };
  }

  // Пробуем несколько источников: первый мог быть заморожен системой.
  let lastError = 'CAPTCHA_FAILED';
  for (const target of targets.slice(0, 3)) {
    try {
      if (!(await wakeTab(target))) continue;
      const resp = await withTimeout(
        requestCaptchaFromFrame(target, requestId, captchaAction),
        CAPTCHA_TIMEOUT_MS,
        'CAPTCHA_TIMEOUT',
      );
      if (resp?.token) return { ...resp, source: target.kind || 'неизвестно' };
      lastError = resp?.error || 'NO_TOKEN';
    } catch (e) {
      lastError = e?.message || 'CAPTCHA_TIMEOUT';
      console.warn(`[Flow] Фрейм ${target.tabId}:${target.frameId} не выдал токен — ${lastError}`);
    }
  }
  return { error: lastError };
}

async function handleSolveCaptcha(msg) {
  const { id, params } = msg;
  const result = await solveCaptcha(id, params?.captchaAction || 'VIDEO_GENERATION');

  metrics.requestCount++;
  if (result?.token) {
    metrics.successCount++;
  } else {
    metrics.failedCount++;
    metrics.lastError = result?.error || 'NO_TOKEN';
  }
  chrome.storage.local.set({ metrics });

  await sendToAgent({ id, result });
}

// ─── Лог запросов ───────────────────────────────────────────

const _VISIBLE_TYPES = new Set(['GEN_IMG', 'CREATE_PROJECT', 'UPSCALE', 'UPLOAD']);

const _RPC_TYPES = {
  jHPbke: 'CREATE_PROJECT',
  ogiZ0b: 'GEN_IMG',
};

function _classifyRpc(rpcid) {
  return _RPC_TYPES[rpcid] || 'API';
}

function persistRequestLog() {
  // Иначе после каждой перезагрузки воркера лог в попапе оказывался пустым
  chrome.storage.local.set({ requestLog: requestLog.slice(0, 50) }).catch(() => {});
}

function addRequestLog(entry) {
  requestLog.unshift(entry);
  if (requestLog.length > 100) requestLog.pop();
  persistRequestLog();
  broadcastRequestLog();
}

function updateRequestLog(id, updates) {
  const entry = requestLog.find((e) => e.id === id);
  if (entry) Object.assign(entry, updates);
  persistRequestLog();
  broadcastRequestLog();
}

function broadcastRequestLog() {
  chrome.runtime.sendMessage({ type: 'REQUEST_LOG_UPDATE', log: requestLog }).catch(() => {});
}

// ─── Прокси batchexecute-запросов ────────────────────────────
//
// Сам fetch не может уйти отсюда (background.js — origin chrome-extension://,
// у него нет cookies сессии Google и запрос упрётся в CORS). Поэтому
// background.js только готовит URL/тело, а сам fetch делегирует странице
// flow.google.com через content.js -> injected.js (см. FLOW_FETCH ниже) —
// это ровно тот же механизм, что уже используется для капчи.

// Воркер постоянно перезапускается, а счётчик в памяти при этом обнулялся бы
// и мог пойти назад. От времени он растёт всегда.
let _lastReqId = 0;
function nextReqId() {
  _lastReqId = Math.max(_lastReqId + 100, (Math.floor(Date.now() / 10) % 9000000) + 1000000);
  return _lastReqId;
}

async function requestFlowFetchFromFrame(target, requestId, url, body, headers) {
  const { tabId, frameId } = target;
  const message = { type: 'FLOW_FETCH', requestId, url, body, headers };
  const options = frameId != null ? { frameId } : undefined;

  try {
    return await chrome.tabs.sendMessage(tabId, message, options);
  } catch (error) {
    const msg = error?.message || '';
    const shouldInject =
      msg.includes('Receiving end does not exist') ||
      msg.includes('Could not establish connection');
    if (!shouldInject) throw error;

    await chrome.scripting.executeScript({
      target: frameId != null ? { tabId, frameIds: [frameId] } : { tabId },
      files: ['keepalive.js', 'content.js'],
    });
    await sleep(500);
    return await chrome.tabs.sendMessage(tabId, message, options);
  }
}

// Фреймы Flow, для которых уже известны bl/f.sid/at. Если таких нет —
// перезагружаем один, чтобы он их прислал.
async function pickFetchTargets() {
  const targets = await findCaptchaTargets();
  const ready = targets.filter((t) => frameConfigs[frameKey(t)]);
  if (ready.length) return ready;
  console.log('[Flow] Ни у одного фрейма Flow нет bl/f.sid/at — перезагружаем');
  const refreshed = await refreshFrameConfig();
  return refreshed ? [refreshed] : [];
}

// Один batchexecute-вызов из конкретного фрейма, с его же bl/f.sid/at.
async function sendFlowFetch(target, rpcid, innerStr, sourcePath) {
  // Сначала будим: выгруженная вкладка при этом перезагрузится и пришлёт
  // новые bl/f.sid/at, старые к этому моменту уже будут стёрты.
  if (!(await wakeTab(target))) return { error: 'TAB_ASLEEP' };

  const key = frameKey(target);
  const deadline = Date.now() + TOKEN_REFRESH_WAIT_MS;
  while (!frameConfigs[key] && Date.now() < deadline) await sleep(500);
  const cfg = frameConfigs[key];
  if (!cfg) return { error: 'NO_BATCH_CONFIG' };

  const freq = JSON.stringify([[[rpcid, innerStr, null, 'generic']]]);
  const qs = new URLSearchParams({
    rpcids: rpcid,
    'source-path': sourcePath || '/',
    bl: cfg.bl,
    'f.sid': cfg.fsid,
    hl: 'ru',
    _reqid: String(nextReqId()),
    rt: 'c',
  });
  const url = `${BATCHEXECUTE_BASE}?${qs.toString()}`;
  const body = `f.req=${encodeURIComponent(freq)}&at=${encodeURIComponent(cfg.at)}`;
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    'X-Same-Domain': '1',
  };

  const requestId = `fetch-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    const resp = await withTimeout(
      requestFlowFetchFromFrame(target, requestId, url, body, headers),
      FETCH_TIMEOUT_MS,
      'FETCH_TIMEOUT',
    );
    if (resp && (resp.text !== undefined || resp.status !== undefined)) return resp;
    return { error: resp?.error || 'NO_RESPONSE' };
  } catch (e) {
    console.warn(`[Flow] Фрейм ${frameKey(target)} не выполнил fetch — ${e?.message}`);
    return { error: e?.message || 'FETCH_TIMEOUT' };
  }
}

async function handleBatchExecute(msg) {
  const { id, params } = msg;
  const { rpcid, argsJson, sourcePath, captchaAction } = params;

  if (!rpcid || argsJson === undefined) {
    await sendToAgent({ id, error: 'MISSING_RPC_PARAMS' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyRpc(rpcid);
  if (_VISIBLE_TYPES.has(logType)) {
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url: rpcid, payloadSummary: argsJson.slice(0, 200) });
  }

  const fail = async (status, error) => {
    await sendToAgent({ id, status, error });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = error; }
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error });
    setState('idle');
  };

  try {
    // Шаг 1: фрейм Flow, для которого известны bl/f.sid/at
    let targets = await pickFetchTargets();
    if (!targets.length) {
      await fail(503, 'NO_BATCH_CONFIG');
      return;
    }

    let result = null;
    let captchaSource = null;
    for (let attempt = 0; attempt < 2 && targets.length; attempt++) {
      const target = targets[0];

      // Шаг 2: токен reCAPTCHA (невидимая, никакого челленджа тут нет —
      // страница Flow просто выдаёт токен, как делает и для самой себя)
      let innerStr = argsJson;
      if (captchaAction) {
        const captchaResult = await solveCaptcha(id, captchaAction, target);
        captchaSource = captchaResult?.source || null;
        if (!captchaResult?.token) {
          const err = captchaResult?.error || 'CAPTCHA_FAILED';
          console.error(`[Flow] Не получен токен reCAPTCHA для ${captchaAction}: ${err}`);
          await fail(403, `CAPTCHA_FAILED: ${err}`);
          return;
        }
        // main.py расставляет плейсхолдер "__CAPTCHA__" на нужных позициях
        // позиционного массива — здесь просто текстовая замена.
        innerStr = innerStr.split('"__CAPTCHA__"').join(JSON.stringify(captchaResult.token));
      }

      // Шаг 3: сам запрос — из контекста страницы flow.google.com (см.
      // FLOW_FETCH в injected.js), иначе не будет cookies сессии
      result = await sendFlowFetch(target, rpcid, innerStr, sourcePath);

      if (result.error) {
        targets = targets.slice(1);
        continue;
      }

      // HTTP 400 от batchexecute — страница сменила сессию, а у нас остались
      // её старые f.sid/at. Google запрос отклонил и ничего не сгенерировал,
      // поэтому безопасно обновить фрейм и повторить один раз с новым токеном.
      if (result.status === 400 && attempt === 0) {
        console.log(`[Flow] HTTP 400 из фрейма ${frameKey(target)} — обновляем его сессию и повторяем`);
        delete frameConfigs[frameKey(target)];
        persistFrameConfigs();
        const refreshed = await refreshFrameConfig(target);
        targets = refreshed ? [refreshed] : targets.slice(1);
        continue;
      }
      break;
    }

    if (!result || result.error) {
      await fail(500, result?.error || 'NO_BATCH_CONFIG');
      return;
    }

    // captchaSource нужен серверу, чтобы при ошибке сразу было видно,
    // откуда пришёл токен — на телефоне консоль расширения недоступна.
    await sendToAgent({ id, status: result.status, data: result.text, captchaSource });

    const responseSummary = result.text ? result.text.slice(0, 300) : null;
    if (result.status >= 200 && result.status < 300) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: result.status, responseSummary });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${result.status}`; }
      updateRequestLog(logId, { status: 'failed', error: `API_${result.status}`, httpStatus: result.status, responseSummary });
    }
  } catch (e) {
    await sendToAgent({ id, status: 500, error: e.message || 'BATCH_EXECUTE_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'BATCH_EXECUTE_FAILED' });
  }

  chrome.storage.local.set({ metrics });
  setState('idle');
}

// ─── Offscreen (дополнительный слой пробуждения) ────────────

let _offscreenCreating = false;

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) return; // мобильные сборки часто без этого API
  try {
    const existing = await chrome.offscreen.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] }).catch(() => []);
    if (existing.length > 0 || _offscreenCreating) return;
    _offscreenCreating = true;
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['BLOBS'],
      justification: 'Периодически будит Service Worker на Android',
    });
    console.log('[Flow] Offscreen-документ создан');
  } catch (e) {
    console.warn('[Flow] Offscreen недоступен:', e.message);
  } finally {
    _offscreenCreating = false;
  }
}

// ─── Состояние и попап ──────────────────────────────────────

function setState(newState) {
  state = newState;
  const badges = { idle: '●', running: '▶', off: '○' };
  const colors = { idle: '#22c55e', running: '#f59e0b', off: '#6b7280' };
  try {
    chrome.action.setBadgeText({ text: badges[state] || '' });
    chrome.action.setBadgeBackgroundColor({ color: colors[state] || '#000' });
  } catch {}
  chrome.runtime.sendMessage({ type: 'STATUS_PUSH' }).catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _, reply) => {
  if (msg.type === 'STATUS') {
    ensureInit().then(async () => {
      reply({
        connected: state !== 'off',
        agentConnected: state !== 'off',
        flowKeyPresent: Object.keys(frameConfigs).length > 0,
        manualDisconnect,
        tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
        metrics: {
          requestCount: metrics.requestCount,
          successCount: metrics.successCount,
          failedCount: metrics.failedCount,
          lastError: metrics.lastError,
        },
        state,
      });
    });
    return true;
  }

  if (msg.type === 'DISCONNECT') {
    manualDisconnect = true;
    chrome.storage.local.set({ manualDisconnect: true });
    setState('off');
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'RECONNECT') {
    manualDisconnect = false;
    chrome.storage.local.set({ manualDisconnect: false });
    ensureInit().then(startPolling);
    reply({ ok: true });
    return true;
  }

  if (msg.type === 'REQUEST_LOG') {
    ensureInit().then(() => reply({ log: requestLog }));
    return true;
  }

  if (msg.type === 'OPEN_FLOW_TAB') {
    chrome.tabs.query({ url: FLOW_TAB_PATTERNS }).then((tabs) => {
      if (tabs.length) {
        chrome.tabs.update(tabs[0].id, { active: true });
        reply({ ok: true, tabId: tabs[0].id });
      } else {
        chrome.tabs.create({ url: FLOW_URL })
          .then((tab) => reply({ ok: true, tabId: tab.id }))
          .catch((e) => reply({ error: e.message }));
      }
    }).catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'REFRESH_TOKEN') {
    ensureInit()
      .then(() => refreshFrameConfig())
      .then((target) => reply({ ok: !!target }))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'TEST_CAPTCHA') {
    solveCaptcha(`test-${Date.now()}`, msg.pageAction || 'IMAGE_GENERATION')
      .then((r) => reply(r))
      .catch((e) => reply({ error: e.message }));
    return true;
  }

  if (msg.type === 'OFFSCREEN_PING') {
    ensureInit().then(startPolling);
    return false;
  }

  return true;
});

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

console.log('[Flow] Расширение загружено');
