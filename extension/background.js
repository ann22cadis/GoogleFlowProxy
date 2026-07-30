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

const FLOW_URL = 'https://labs.google/fx/tools/flow';
const FLOW_TAB_PATTERNS = [
  'https://labs.google/fx/tools/flow*',
  'https://labs.google/fx/*/tools/flow*',
];

// На Android вкладка тормознутая: grecaptcha после разморозки отвечает
// по 10–20 секунд. Старые 5 секунд гарантировали вечный CAPTCHA_TIMEOUT.
const CAPTCHA_TIMEOUT_MS = 35000;
const TAB_WAKE_TIMEOUT_MS = 25000;
const TOKEN_REFRESH_WAIT_MS = 25000;

let flowKey = null;
let flowKeyCapturedAt = null;
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
// не вызывался, из-за чего flowKey оставался null и каждый запрос падал
// с NO_FLOW_KEY. Теперь состояние подтягивается при любом оживлении.

let _initPromise = null;

function ensureInit() {
  if (!_initPromise) _initPromise = doInit();
  return _initPromise;
}

async function doInit() {
  try {
    const d = await chrome.storage.local.get([
      'flowKey', 'flowKeyCapturedAt', 'metrics', 'manualDisconnect', 'requestLog',
    ]);
    if (d.flowKey) flowKey = d.flowKey;
    if (d.flowKeyCapturedAt) flowKeyCapturedAt = d.flowKeyCapturedAt;
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
  chrome.alarms.create('token-refresh', { periodInMinutes: 30 });
  chrome.alarms.create('telemetry', { periodInMinutes: 2 });
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  await ensureInit();
  if (alarm.name === 'poll-watchdog') {
    startPolling();
    ensureOffscreenDocument();
  } else if (alarm.name === 'token-refresh') {
    await refreshToken();
  } else if (alarm.name === 'telemetry') {
    // Не на каждый будильник — чтобы интервалы выглядели живыми
    if (Math.random() < 0.45) await sendTelemetry();
  }
});

chrome.runtime.onInstalled.addListener(() => { ensureInit().then(startPolling); });
chrome.runtime.onStartup.addListener(() => { ensureInit().then(startPolling); });

// Главное: старт при КАЖДОМ оживлении воркера, чем бы оно ни было вызвано.
ensureInit().then(startPolling);

// ─── Реестр живых Flow-фреймов ──────────────────────────────
// Вкладка labs.google на Android легко выгружается. Но captcha умеет выдавать
// любой фрейм с origin labs.google — в том числе скрытый iframe, который
// st_injector.js вставляет прямо во вкладку SillyTavern. Такой фрейм живёт
// ровно столько, сколько открыта вкладка, которой пользователь реально
// пользуется, поэтому он куда надёжнее отдельной вкладки Labs.

const flowFrames = new Map(); // "tabId:frameId" -> { tabId, frameId, url, ts }

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'flow-frame') return;

  const tabId = port.sender?.tab?.id;
  const frameId = port.sender?.frameId ?? 0;
  const url = port.sender?.url || '';
  if (tabId == null || !url.startsWith('https://labs.google/')) return;

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
    if (job.method === 'api_request') {
      await handleApiRequest(job);
    } else if (job.method === 'trpc_request') {
      await handleTrpcRequest(job);
    } else if (job.method === 'solve_captcha') {
      await handleSolveCaptcha(job);
    } else if (job.method === 'get_status') {
      await sendToAgent({
        id: job.id,
        result: {
          state,
          flowKeyPresent: !!flowKey,
          manualDisconnect,
          tokenAge: metrics.tokenCapturedAt ? Date.now() - metrics.tokenCapturedAt : null,
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

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!details?.requestHeaders?.length) return;
    const authHeader = details.requestHeaders.find(
      (h) => h.name?.toLowerCase() === 'authorization',
    );
    const value = authHeader?.value || '';
    if (!value.startsWith('Bearer ya29.')) return;

    const token = value.replace(/^Bearer\s+/i, '').trim();
    if (!token) return;

    flowKey = token;
    flowKeyCapturedAt = Date.now();
    metrics.tokenCapturedAt = flowKeyCapturedAt;
    chrome.storage.local.set({ flowKey, flowKeyCapturedAt, metrics });
    console.log('[Flow] Токен пойман');
  },
  { urls: ['https://aisandbox-pa.googleapis.com/*', 'https://labs.google/*'] },
  ['requestHeaders', 'extraHeaders'],
);

async function getFlowKey() {
  if (flowKey) return flowKey;
  // Воркер мог перезапуститься уже после того, как токен был пойман
  const d = await chrome.storage.local.get(['flowKey', 'flowKeyCapturedAt']);
  if (d.flowKey) {
    flowKey = d.flowKey;
    flowKeyCapturedAt = d.flowKeyCapturedAt || null;
  }
  return flowKey;
}

async function refreshToken() {
  // Токен ловится пассивно из трафика страницы, поэтому единственный
  // надёжный способ его обновить — заставить страницу Flow сходить в сеть.
  const before = flowKeyCapturedAt || 0;
  const targets = await findCaptchaTargets();

  // chrome.tabs.reload перезагружает ВКЛАДКУ целиком, а скрытый iframe Labs
  // живёт внутри страницы SillyTavern. Раньше цель бралась первой попавшейся,
  // и если настоящей вкладки Labs не было, у человека посреди генерации
  // перезагружалась Таверна вместе с чатом. Вкладку трогаем, только если она
  // сама и есть цель; фрейм обновляем изнутри, не задевая страницу вокруг.
  const topLevel = targets.find((t) => t.frameId === 0);

  if (topLevel) {
    try {
      await chrome.tabs.reload(topLevel.tabId);
    } catch {
      return false;
    }
  } else if (targets.length) {
    if (!(await reloadFrame(targets[0]))) return false;
  } else {
    const opened = await openFlowTab();
    if (!opened) return false;
  }

  const deadline = Date.now() + TOKEN_REFRESH_WAIT_MS;
  while (Date.now() < deadline) {
    const d = await chrome.storage.local.get('flowKeyCapturedAt');
    if ((d.flowKeyCapturedAt || 0) > before) {
      flowKey = (await chrome.storage.local.get('flowKey')).flowKey;
      flowKeyCapturedAt = d.flowKeyCapturedAt;
      console.log('[Flow] Токен обновлён');
      return true;
    }
    await sleep(1000);
  }
  console.warn('[Flow] Токен обновить не удалось');
  return false;
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
  // Labs идёт первой всегда, а iframe остаётся аварийным вариантом.

  // 1. Настоящие вкладки labs.google: активная -> живая -> выгруженная
  const tabs = await chrome.tabs.query({ url: FLOW_TAB_PATTERNS }).catch(() => []);
  const rank = (t) => (t.active ? -1 : 0) + (t.discarded ? 2 : 0);
  tabs.sort((a, b) => rank(a) - rank(b));
  for (const t of tabs) {
    if (t.id != null) push({ tabId: t.id, frameId: 0, kind: 'вкладка Labs', discarded: !!t.discarded });
  }

  // 2. Верхнеуровневые фреймы, сообщившие о себе по порту
  for (const f of [...flowFrames.values()].sort((a, b) => b.ts - a.ts)) {
    if (f.frameId === 0) push({ ...f, kind: 'вкладка Labs' });
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
        if (fr.frameId !== 0 && fr.url?.startsWith('https://labs.google/fx/')) {
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
    // пропускаем эту цель: следующей в списке идёт настоящая вкладка Labs.
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
    console.log('[Flow] Вкладки Labs нет — открываем в фоне');
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
      files: ['content.js'],
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

async function solveCaptcha(requestId, captchaAction) {
  await ensureInit();

  let targets = await findCaptchaTargets();
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

const _VISIBLE_TYPES = new Set(['GEN_IMG', 'GEN_VID', 'GEN_VID_REF', 'UPSCALE', 'TRACKING', 'URL_REFRESH']);

function _classifyApiUrl(url) {
  if (url.includes('uploadImage'))                     return 'UPLOAD';
  if (url.includes('batchGenerateImages'))              return 'GEN_IMG';
  if (url.includes('UpsampleVideo'))                   return 'UPSCALE';
  if (url.includes('ReferenceImages'))                 return 'GEN_VID_REF';
  if (url.includes('batchAsyncGenerateVideo'))          return 'GEN_VID';
  if (url.includes('batchCheckAsync'))                  return 'POLL';
  if (url.includes('upsampleImage'))                   return 'UPS_IMG';
  if (url.includes('/media/'))                         return 'MEDIA';
  if (url.includes('/credits'))                        return 'CREDITS';
  return 'API';
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

// ─── Прокси запросов ────────────────────────────────────────

async function handleTrpcRequest(msg) {
  const { id, params } = msg;
  const { url, method = 'POST', headers = {}, body } = params;

  if (!url || !url.startsWith('https://labs.google/')) {
    await sendToAgent({ id, error: 'INVALID_TRPC_URL' });
    return;
  }

  setState('running');

  const fetchHeaders = { 'Content-Type': 'application/json', ...headers };
  const key = await getFlowKey();
  if (key) fetchHeaders['authorization'] = `Bearer ${key}`;

  try {
    const resp = await fetch(url, {
      method,
      headers: fetchHeaders,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'include',
    });
    const data = await resp.json();
    await sendToAgent({ id, status: resp.status, data });
  } catch (e) {
    console.error('[Flow] tRPC запрос не прошёл:', e);
    await sendToAgent({ id, error: e.message || 'TRPC_FETCH_FAILED' });
  } finally {
    setState('idle');
  }
}

async function handleApiRequest(msg) {
  const { id, params } = msg;
  const { url, method, headers, body, captchaAction } = params;

  if (!url) {
    await sendToAgent({ id, error: 'MISSING_URL' });
    return;
  }
  if (!url.startsWith('https://aisandbox-pa.googleapis.com/')) {
    await sendToAgent({ id, error: 'INVALID_URL' });
    return;
  }

  setState('running');
  const hasCaptcha = !!captchaAction;
  if (hasCaptcha) metrics.requestCount++;

  const logId = id;
  const logType = _classifyApiUrl(url);
  if (_VISIBLE_TYPES.has(logType)) {
    const payloadSummary = body ? JSON.stringify(body).slice(0, 200) : null;
    addRequestLog({ id: logId, type: logType, time: new Date().toISOString(), status: 'processing', error: null, outputUrl: null, url, payloadSummary });
  }

  const fail = async (status, error) => {
    await sendToAgent({ id, status, error });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = error; }
    chrome.storage.local.set({ metrics });
    updateRequestLog(logId, { status: 'failed', error });
    setState('idle');
  };

  try {
    // Шаг 1: токен reCAPTCHA (невидимая, никакого челленджа тут нет —
    // страница Labs просто выдаёт токен, как делает и для самой себя)
    let captchaToken = null;
    let captchaSource = null;
    if (captchaAction) {
      const captchaResult = await solveCaptcha(id, captchaAction);
      captchaToken = captchaResult?.token || null;
      captchaSource = captchaResult?.source || null;
      if (!captchaToken) {
        const err = captchaResult?.error || 'CAPTCHA_FAILED';
        console.error(`[Flow] Не получен токен reCAPTCHA для ${captchaAction}: ${err}`);
        await fail(403, `CAPTCHA_FAILED: ${err}`);
        return;
      }
    }

    // Шаг 2: вставляем токен капчи в тело
    let finalBody = body;
    if (captchaToken && finalBody) {
      finalBody = JSON.parse(JSON.stringify(finalBody));
      if (finalBody.clientContext?.recaptchaContext) {
        finalBody.clientContext.recaptchaContext.token = captchaToken;
      }
      if (Array.isArray(finalBody.requests)) {
        for (const req of finalBody.requests) {
          if (req.clientContext?.recaptchaContext) {
            req.clientContext.recaptchaContext.token = captchaToken;
          }
        }
      }
    }

    // Шаг 3: авторизация
    let activeFlowKey = await getFlowKey();
    if (!activeFlowKey) {
      console.log('[Flow] Токена нет — пробуем добыть');
      await refreshToken();
      activeFlowKey = await getFlowKey();
    }
    if (!activeFlowKey) {
      await fail(503, 'NO_FLOW_KEY');
      return;
    }

    // Шаг 4: сам запрос, с одной повторной попыткой на протухший токен
    const doFetch = async (key) => fetch(url, {
      method: method || 'POST',
      headers: { ...(headers || {}), authorization: `Bearer ${key}` },
      credentials: 'include',
      body: method === 'GET' ? undefined : JSON.stringify(finalBody),
    });

    let response = await doFetch(activeFlowKey);

    if (response.status === 401) {
      console.log('[Flow] Токен протух (401) — обновляем и пробуем ещё раз');
      if (await refreshToken()) {
        const fresh = await getFlowKey();
        if (fresh) response = await doFetch(fresh);
      }
    }

    let responseData;
    const responseText = await response.text();
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    // captchaSource нужен серверу, чтобы при 403 сразу было видно,
    // откуда пришёл токен — на телефоне консоль расширения недоступна.
    await sendToAgent({ id, status: response.status, data: responseData, captchaSource });

    const responseSummary = responseText ? responseText.slice(0, 300) : null;
    if (response.ok) {
      if (hasCaptcha) { metrics.successCount++; metrics.lastError = null; }
      updateRequestLog(logId, { status: 'success', httpStatus: response.status, responseSummary });
    } else {
      if (hasCaptcha) { metrics.failedCount++; metrics.lastError = `API_${response.status}`; }
      updateRequestLog(logId, { status: 'failed', error: `API_${response.status}`, httpStatus: response.status, responseSummary });
    }
  } catch (e) {
    await sendToAgent({ id, status: 500, error: e.message || 'API_REQUEST_FAILED' });
    if (hasCaptcha) { metrics.failedCount++; metrics.lastError = e.message; }
    updateRequestLog(logId, { status: 'failed', error: e.message || 'API_REQUEST_FAILED' });
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
      await getFlowKey();
      reply({
        connected: state !== 'off',
        agentConnected: state !== 'off',
        flowKeyPresent: !!flowKey,
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
      .then(refreshToken)
      .then((ok) => reply({ ok }))
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

  if (msg.type === 'TRPC_MEDIA_URLS') {
    handleTrpcMediaUrls(msg.trpcUrl, msg.body);
    reply({ ok: true });
    return true;
  }

  return true;
});

// ─── TRPC Media URL Extractor ──────────────────────────────

function handleTrpcMediaUrls(trpcUrl, bodyText) {
  try {
    const urlRegex = /https:\/\/storage\.googleapis\.com\/ai-sandbox-videofx\/(?:image|video)\/[0-9a-f-]{36}\?[^"'\s]+/g;
    const matches = bodyText.match(urlRegex) || [];
    if (!matches.length) return;

    const urlMap = {};
    for (const rawUrl of matches) {
      const url = rawUrl.replace(/\\u0026/g, '&').replace(/\\/g, '');
      const mediaMatch = url.match(/\/(image|video)\/([0-9a-f-]{36})\?/);
      if (mediaMatch) {
        const [, mediaType, mediaId] = mediaMatch;
        urlMap[mediaId] = { mediaType, url, mediaId };
      }
    }

    const entries = Object.values(urlMap);
    if (!entries.length) return;

    console.log(`[Flow] Поймали ${entries.length} свежих media URL из TRPC`);
    sendToAgent({ type: 'media_urls_refresh', urls: entries });
  } catch (e) {
    console.error('[Flow] Не смогли разобрать TRPC media URL:', e);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ─── Телеметрия «как у живого пользователя» ────────────────

const _UA = navigator.userAgent;

function _rand(min, max) { return Math.floor(Math.random() * (max - min + 1)) + min; }

async function _sessionId() {
  const { telemetrySession } = await chrome.storage.local.get('telemetrySession');
  const now = Date.now();
  // Сессия живёт ~30 минут, как у настоящего пользователя. Раньше она лежала
  // в памяти воркера и обнулялась при каждой его смерти.
  if (telemetrySession && now - telemetrySession.created < 30 * 60 * 1000) {
    return telemetrySession.id;
  }
  const id = `;${now}`;
  await chrome.storage.local.set({ telemetrySession: { id, created: now } });
  return id;
}

function _buildBatchLogPayload(sessionId) {
  const events = [];
  const types = ['FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY'];
  const count = _rand(1, 3);
  for (let i = 0; i < count; i++) {
    events.push({
      event: types[_rand(0, types.length - 1)],
      eventProperties: [
        { key: 'CURRENT_TIME_MS', doubleValue: Date.now() },
        { key: 'DURATION_MS', doubleValue: _rand(150, 800) },
        { key: 'USER_AGENT', stringValue: _UA },
        { key: 'IS_DESKTOP', booleanValue: true },
      ],
      eventMetadata: { sessionId },
      eventTime: new Date().toISOString(),
    });
  }
  return { appEvents: events };
}

function _buildFrontendEventsPayload(sessionId) {
  const eventTypes = [
    'FLOW_IMAGE_LATENCY', 'FLOW_VIDEO_LATENCY', 'GRID_SCROLL_DEPTH',
    'FLOW_PROJECT_OPEN', 'FLOW_SCENE_VIEW',
  ];
  const count = _rand(1, 4);
  const events = [];
  for (let i = 0; i < count; i++) {
    const et = eventTypes[_rand(0, eventTypes.length - 1)];
    const params = {
      USER_AGENT: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: _UA },
      IS_DESKTOP: { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'true' },
    };
    if (et.includes('LATENCY')) {
      params.CURRENT_TIME_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(Date.now()) };
      params.DURATION_MS = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: String(_rand(100, 600)) };
    }
    if (et === 'GRID_SCROLL_DEPTH') {
      params.MEDIA_GENERATION_PAYGATE_TIER = { '@type': 'type.googleapis.com/google.protobuf.StringValue', value: 'PAYGATE_TIER_TWO' };
    }
    events.push({
      eventType: et,
      metadata: { sessionId, createTime: new Date().toISOString(), additionalParams: params },
    });
  }
  return { events };
}

async function sendTelemetry() {
  const key = await getFlowKey();
  if (!key || state === 'off') return;

  const sessionId = await _sessionId();
  const headers = {
    'Content-Type': 'text/plain;charset=UTF-8',
    'authorization': `Bearer ${key}`,
  };

  try {
    if (Math.random() < 0.5) {
      await fetch('https://aisandbox-pa.googleapis.com/v1:batchLog', {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildBatchLogPayload(sessionId)),
      });
    } else {
      await fetch('https://aisandbox-pa.googleapis.com/v1/flow:batchLogFrontendEvents', {
        method: 'POST', headers, credentials: 'include',
        body: JSON.stringify(_buildFrontendEventsPayload(sessionId)),
      });
    }
  } catch {}
}

console.log('[Flow] Расширение загружено');
