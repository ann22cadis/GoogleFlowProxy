/**
 * Внедряется во вкладку SillyTavern (127.0.0.1 / localhost).
 *
 * Вставляет скрытый iframe с Google Flow. Смысл в том, что на Android
 * отдельная вкладка Labs живёт недолго — система её замораживает и выгружает,
 * как только пользователь переключается на что-то другое. А вкладка
 * SillyTavern открыта всегда, потому что в ней и идёт игра.
 *
 * grecaptcha не требует авторизации — ей нужен только origin labs.google.
 * Поэтому такой iframe является полноценным источником капчи, и расширение
 * умеет его находить (background.js -> findCaptchaTargets).
 */

const FLOW_IFRAME_ID = 'flow-keepalive-frame';
const IFRAME_RELOAD_MS = 20 * 60 * 1000; // раз в 20 минут, чтобы токен и grecaptcha не протухали

function injectIframe() {
  const existing = document.getElementById(FLOW_IFRAME_ID);
  if (existing) return existing;

  console.log('[Flow] Вставляем скрытый iframe Google Labs');
  const iframe = document.createElement('iframe');
  iframe.id = FLOW_IFRAME_ID;
  iframe.src = 'https://labs.google/fx/tools/flow';
  // Размер настоящий, а не 1x1: reCAPTCHA меряет вьюпорт, и окно в один
  // пиксель для неё — явный признак бота (ответ PUBLIC_ERROR_UNUSUAL_ACTIVITY).
  // Прячем через clip-path, а не через нулевой размер.
  iframe.style.cssText =
    'width:360px;height:640px;position:fixed;bottom:0;right:0;pointer-events:none;' +
    'z-index:-9999;border:0;clip-path:inset(50%);';
  // autoplay нужен, чтобы внутри фрейма при необходимости мог играть keepalive-звук
  iframe.allow = 'autoplay; camera; microphone';
  document.body.appendChild(iframe);
  return iframe;
}

function startIframeGuard() {
  injectIframe();

  // Роутер SillyTavern или сборщик мусора могут выкинуть наш iframe — следим
  setInterval(() => {
    if (!document.getElementById(FLOW_IFRAME_ID)) {
      console.log('[Flow] iframe пропал — вставляем заново');
      injectIframe();
    }
  }, 30000);

  // Периодически перезагружаем: свежий grecaptcha и свежий Bearer-токен
  setInterval(() => {
    const frame = document.getElementById(FLOW_IFRAME_ID);
    if (frame) {
      console.log('[Flow] Обновляем iframe Labs');
      frame.src = frame.src;
    }
  }, IFRAME_RELOAD_MS);
}

function boot() {
  // Вкладка SillyTavern открыта всё время игры — именно её мы и защищаем
  // от засыпания звуковой медиа-сессией (см. keepalive.js).
  flowStartAudioKeepalive();
  setTimeout(startIframeGuard, 2000);
}

if (document.readyState === 'complete') {
  boot();
} else {
  window.addEventListener('load', boot);
}
