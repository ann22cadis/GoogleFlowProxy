/**
 * Работает в MAIN world на flow.google.com — только тут доступен
 * window.grecaptcha, и только отсюда fetch() к batchexecute уходит как
 * настоящий same-origin запрос страницы (с её cookies сессии — новый
 * протокол Google Flow авторизуется именно так, без Bearer-токена).
 *
 * Скрипт грузится в каждый фрейм flow.google.com (включая скрытый iframe во
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

  // ─── Выполнение batchexecute-запроса из контекста страницы ──
  // Именно поэтому этот fetch не может уйти из background.js расширения:
  // авторизация нового Google Flow — обычные cookies сессии, а не заголовок,
  // который можно скопировать и переиспользовать из другого контекста.
  window.addEventListener('FLOW_FETCH', async ({ detail }) => {
    const { requestId, url, body, headers } = detail;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: headers || {},
        credentials: 'include',
        body,
      });
      const text = await resp.text();
      window.dispatchEvent(new CustomEvent('FLOW_FETCH_RESULT', {
        detail: { requestId, status: resp.status, text },
      }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('FLOW_FETCH_RESULT', {
        detail: { requestId, error: e.message || 'FETCH_FAILED' },
      }));
    }
  });

  // ─── Выдача токена капчи ─────────────────────────────────
  window.addEventListener('GET_CAPTCHA', async ({ detail }) => {
    const { requestId, pageAction } = detail;
    try {
      const token = await getCaptchaToken(pageAction);
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', { detail: { requestId, token } }));
    } catch (e) {
      window.dispatchEvent(new CustomEvent('CAPTCHA_RESULT', { detail: { requestId, error: e.message } }));
    }
  });

  async function getCaptchaToken(pageAction) {
    // Новый flow.google.com подгружает reCAPTCHA не на каждой странице (на
    // ленте проектов её нет, а после перезагрузки вкладки она появляется
    // только когда сайту самому понадобится). Не ждём этого — если скрипта
    // нет, подгружаем его сами с тем же sitekey, что использует сайт.
    if (!(await waitForGrecaptcha(3000))) {
      await loadRecaptchaScript();
      // Короче таймаута content.js (30 с), чтобы фон успел попробовать другой фрейм
      if (!(await waitForGrecaptcha(15000))) throw new Error('grecaptcha not available');
    }

    try {
      return await executeWhenReady(pageAction);
    } catch (e) {
      // Сайт мог загрузить reCAPTCHA без render=SITE_KEY — тогда execute с
      // ключом падает. Догружаем свою копию с нужным ключом и пробуем ещё раз.
      if (_recaptchaLoading) throw e;
      await loadRecaptchaScript();
      return await executeWhenReady(pageAction);
    }
  }

  function executeWhenReady(pageAction) {
    return new Promise((resolve, reject) => {
      window.grecaptcha.enterprise.ready(() => {
        window.grecaptcha.enterprise.execute(SITE_KEY, { action: pageAction }).then(resolve, reject);
      });
    });
  }

  let _recaptchaLoading = null;

  function loadRecaptchaScript() {
    if (_recaptchaLoading) return _recaptchaLoading;
    _recaptchaLoading = new Promise((resolve) => {
      const url = `https://www.google.com/recaptcha/enterprise.js?render=${SITE_KEY}`;
      const s = document.createElement('script');
      try {
        // У сайта включён Trusted Types: строку в script.src без политики не пустят
        const policy = window.trustedTypes?.createPolicy?.('flow-proxy-recaptcha', { createScriptURL: (u) => u });
        s.src = policy ? policy.createScriptURL(url) : url;
      } catch {
        s.src = url;
      }
      s.async = true;
      s.onload = () => resolve(true);
      s.onerror = () => resolve(false);
      (document.head || document.documentElement).appendChild(s);
      console.log('[Flow] Подгружаем reCAPTCHA на страницу сами');
    });
    return _recaptchaLoading;
  }

  // На Android после разморозки вкладки grecaptcha поднимается медленно.
  function waitForGrecaptcha(timeout) {
    return new Promise((resolve) => {
      const start = Date.now();
      const check = () => {
        if (window.grecaptcha?.enterprise?.execute) return resolve(true);
        if (Date.now() - start > timeout) return resolve(false);
        setTimeout(check, 200);
      };
      check();
    });
  }
})();
