/**
 * Работает в MAIN world на flow.google.com с document_start — раньше кода сайта.
 *
 * С октября 2026 сайт Flow подменяет grecaptcha.enterprise.execute: любой
 * вызов «снаружи» уходит в Google с действием extension_hijack_detected, и
 * запрос отклоняется как UNUSUAL_ACTIVITY. Сам сайт ходит через оригинал,
 * который прячет у себя: `d = execute.bind(execute.__this)`.
 *
 * Мы забираем тот же оригинал в момент, когда сайт делает bind, и позже
 * просим токен через него — так же, как это делает сама страница.
 */
(function () {
  const SLOT = Symbol.for('flowProxy.recaptchaExecute');
  if (window[SLOT] !== undefined) return;

  Object.defineProperty(window, SLOT, { value: null, writable: true, configurable: true, enumerable: false });

  const nativeBind = Function.prototype.bind;
  Function.prototype.bind = function (thisArg, ...args) {
    const bound = Reflect.apply(nativeBind, this, [thisArg, ...args]);
    try {
      const enterprise = window.grecaptcha && window.grecaptcha.enterprise;
      if (enterprise && thisArg === enterprise && this === enterprise.execute) {
        window[SLOT] = bound;
      }
    } catch { /* страница не должна заметить наше присутствие */ }
    return bound;
  };
})();
