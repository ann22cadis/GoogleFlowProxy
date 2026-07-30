/**
 * Content script на labs.google — мост между background.js и injected.js.
 * Работает во ВСЕХ фреймах, включая скрытый iframe, который st_injector.js
 * вставляет во вкладку SillyTavern: капчу умеет выдавать любой фрейм
 * с origin labs.google, и такой iframe переживает Android гораздо лучше,
 * чем отдельная вкладка Labs.
 */

// Скрипт может быть внедрён повторно через chrome.scripting — не дублируем слушателей
if (!window.__flowContentLoaded) {
  window.__flowContentLoaded = true;

  (function injectMainWorld() {
    const s = document.createElement('script');
    s.src = chrome.runtime.getURL('injected.js');
    s.onload = () => s.remove();
    (document.head || document.documentElement).appendChild(s);
  })();

  chrome.runtime.onMessage.addListener((msg, _, reply) => {
    if (msg.type !== 'GET_CAPTCHA') return;

    const { requestId, pageAction } = msg;

    const handler = (e) => {
      if (e.detail?.requestId === requestId) {
        window.removeEventListener('CAPTCHA_RESULT', handler);
        clearTimeout(timer);
        reply({ token: e.detail.token, error: e.detail.error });
      }
    };

    // Должен быть короче таймаута в background.js (35 с), чтобы фон получил
    // внятную ошибку и успел попробовать другой фрейм.
    const timer = setTimeout(() => {
      window.removeEventListener('CAPTCHA_RESULT', handler);
      reply({ error: 'CONTENT_TIMEOUT' });
    }, 30000);

    window.addEventListener('CAPTCHA_RESULT', handler);
    window.dispatchEvent(new CustomEvent('GET_CAPTCHA', { detail: { requestId, pageAction } }));

    return true; // держим канал открытым для асинхронного ответа
  });

  // ─── TRPC Media URL Monitor ───────────────────────────────
  window.addEventListener('TRPC_MEDIA_URLS', (e) => {
    const { url, body } = e.detail || {};
    if (!body) return;
    chrome.runtime.sendMessage({ type: 'TRPC_MEDIA_URLS', trpcUrl: url, body }).catch(() => {});
  });

  // ─── Порт до Service Worker ───────────────────────────────
  // Открытый порт не даёт воркеру уснуть и заодно сообщает фону, что в этом
  // фрейме можно решать капчу. Chrome принудительно рвёт порт через 5 минут,
  // поэтому пересоздаём его сами каждые 4 минуты, не дожидаясь обрыва.
  (function startPortKeepalive() {
    let port = null;
    let pingTimer = null;
    let recycleTimer = null;

    function cleanup() {
      clearInterval(pingTimer);
      clearTimeout(recycleTimer);
    }

    function connect() {
      cleanup();
      try {
        port = chrome.runtime.connect({ name: 'flow-frame' });

        pingTimer = setInterval(() => {
          try {
            port.postMessage({ type: 'ping' });
          } catch {
            cleanup();
          }
        }, 20000);

        recycleTimer = setTimeout(() => {
          try { port.disconnect(); } catch {}
          connect();
        }, 4 * 60 * 1000);

        port.onDisconnect.addListener(() => {
          cleanup();
          setTimeout(connect, 1000);
        });
      } catch {
        // Расширение могло обновиться — пробуем снова
        setTimeout(connect, 2000);
      }
    }

    connect();
  })();

  // ─── Звуковой keepalive (см. keepalive.js) ────────────────
  // Только в верхнем фрейме: если мы внутри iframe на странице SillyTavern,
  // звук уже играет сама эта страница (st_injector.js), второй поток не нужен.
  if (window.top === window) flowStartAudioKeepalive();
}
