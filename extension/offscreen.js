/**
 * Flow — Offscreen Document Keepalive
 *
 * Этот документ живёт в фоне и будит Service Worker каждые 10 секунд.
 * Chrome не убивает offscreen документы так агрессивно, как SW на Android.
 */

console.log('[Flow Offscreen] Keepalive document loaded');

// Бьём SW каждые 10 секунд
setInterval(() => {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_PING' }).catch(() => {
    // SW мог умереть — это нормально, он сам пересоздастся при следующем сообщении
  });
}, 10000);

// Также делаем fetch на /health чтобы держать сетевую активность
setInterval(async () => {
  try {
    await fetch('http://127.0.0.1:8001/health', { method: 'GET', cache: 'no-store' });
  } catch {
    // Сервер не запущен — не страшно, SW всё равно разбудился
  }
}, 15000);
