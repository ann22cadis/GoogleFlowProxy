/**
 * Работает в MAIN world на labs.google — только тут доступен window.grecaptcha.
 * Заодно перехватывает ответы TRPC, чтобы ловить свежие подписанные media URL.
 *
 * Скрипт грузится в каждый фрейм labs.google (включая скрытый iframe во
 * вкладке SillyTavern), поэтому защищаемся от повторной установки хуков.
 */
(function () {
  if (window.__flowInjected) return;
  window.__flowInjected = true;

  const SITE_KEY = '6LdsFiUsAAAAAIjVDZcuLhaHiDn5nnHVXVRQGeMV';

  // ─── Подмена видимости (анти-троттлинг) ──────────────────
  // Свёрнутая вкладка получает hidden=true и замороженный rAF, после чего
  // reCAPTCHA Enterprise отказывается выдавать токен. Убеждаем страницу,
  // что на неё всё время смотрят.
  try {
    Object.defineProperty(document, 'visibilityState', { get: () => 'visible', configurable: true });
    Object.defineProperty(document, 'hidden', { get: () => false, configurable: true });
  } catch (e) {
    console.warn('[Flow] Не смогли подменить visibilityState:', e);
  }

  try {
    let lastTime = 0;
    window.requestAnimationFrame = function (callback) {
      const currTime = Date.now();
      const timeToCall = Math.max(0, 16 - (currTime - lastTime));
      const id = window.setTimeout(() => callback(currTime + timeToCall), timeToCall);
      lastTime = currTime + timeToCall;
      return id;
    };
    window.cancelAnimationFrame = function (id) { clearTimeout(id); };
  } catch (e) {
    console.warn('[Flow] Не смогли подменить rAF:', e);
  }

  // ─── Перехват ответов TRPC ───────────────────────────────
  const _originalFetch = window.fetch;
  window.fetch = async function (...args) {
    const response = await _originalFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || '';
      if (url.includes('/fx/api/trpc/') && response.ok) {
        const clone = response.clone();
        clone.text().then((text) => {
          if (text.includes('storage.googleapis.com/ai-sandbox-videofx/')) {
            window.dispatchEvent(new CustomEvent('TRPC_MEDIA_URLS', { detail: { url, body: text } }));
          }
        }).catch(() => {});
      }
    } catch {}
    return response;
  };

  // ─── Выдача токена капчи ─────────────────────────────────
  window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
    const { requestId, pageAction } = detail;
    try {
      await waitForGrecaptcha();
      const token = await window.grecaptcha.enterprise.execute(SITE_KEY, { action: pageAction });
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', { detail: { requestId, token } }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', { detail: { requestId, error: e.message } }));
    }
  });

  // На Android после разморозки вкладки grecaptcha поднимается медленно,
  // прежних 10 секунд не хватало.
  function waitForGrecaptcha(timeout = 20000) {
    return new Promise((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (window.grecaptcha?.enterprise?.execute) return resolve();
        if (Date.now() - start > timeout) return reject(new Error('grecaptcha not available'));
        setTimeout(check, 200);
      };
      check();
    });
  }
})();
