/**
 * Flow — общий keepalive для страниц (Android)
 *
 * Подключается первым в списке content_scripts, поэтому его функции видны
 * в content.js и st_injector.js.
 *
 * Зачем это нужно.
 * Android замораживает, а потом и выгружает фоновые вкладки браузера — вместе
 * с ними умирает всё расширение. Единственное, что система не имеет права
 * трогать, — вкладка, которая ВОСПРОИЗВОДИТ ЗВУК: она получает медиа-сессию,
 * и браузер переходит в режим foreground service.
 *
 * Прошлая версия проигрывала абсолютную тишину — Chromium считает такой поток
 * неслышимым (порог примерно -72 dBFS), медиа-сессия не создаётся, и защиты
 * не было никакой. Здесь генерируется тон 30 Гц на уровне ~-46 dBFS: для
 * системы это «звук», а для человека — ничто, потому что динамик телефона
 * такие частоты физически не воспроизводит.
 */

// seconds = 15 не случайно: Chromium не создаёт постоянное уведомление
// (медиа-сессию) для звука короче ~5 секунд — считает его звуковым эффектом.
// С прежним двухсекундным лупом плеер в шторке появлялся, только если в той же
// вкладке играло что-то ещё, например MoodTube, — и тогда забирал наши подписи.
function flowBuildToneWav({ freq = 30, seconds = 15, amplitude = 160, rate = 8000 } = {}) {
  const samples = rate * seconds;
  const dataBytes = samples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const ascii = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // моно
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, dataBytes, true);

  for (let i = 0; i < samples; i++) {
    const s = Math.round(amplitude * Math.sin((2 * Math.PI * freq * i) / rate));
    view.setInt16(44 + i * 2, s, true);
  }

  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return 'data:audio/wav;base64,' + btoa(bin);
}

let _flowAudio = null;
let _flowAudioArmed = false;
let _flowUserPaused = false;   // пользователь сам нажал паузу — уважаем это

async function flowSetKeepaliveEnabled(enabled) {
  _flowUserPaused = !enabled;
  try { await chrome.storage.local.set({ audioKeepalive: enabled }); } catch {}
  try { navigator.mediaSession.playbackState = enabled ? 'playing' : 'paused'; } catch {}
}

async function flowStartAudioKeepalive() {
  if (_flowAudioArmed) return;
  _flowAudioArmed = true;

  try {
    const { audioKeepalive } = await chrome.storage.local.get('audioKeepalive');
    if (audioKeepalive === false) {
      console.log('[Flow] Звуковой keepalive выключен пользователем');
      return;
    }
  } catch {}

  try {
    _flowAudio = new Audio(flowBuildToneWav());
    _flowAudio.loop = true;
    _flowAudio.volume = 1;

    // Android постоянно жмёт паузу за нас — поднимаемся обратно.
    // Но если паузу нажал пользователь, не спорим с ним.
    const resume = () => { if (!_flowUserPaused) _flowAudio.play().catch(() => {}); };
    _flowAudio.addEventListener('pause', resume);
    _flowAudio.addEventListener('ended', resume);

    const tryPlay = () => _flowAudio.play()
      .then(() => {
        console.log('[Flow] Звуковой keepalive запущен — Android не тронет эту вкладку');
        try {
          navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Flow Proxy',
            artist: 'keepalive — пауза выключает защиту от засыпания',
          });
          navigator.mediaSession.playbackState = 'playing';

          // Кнопка паузы в шторке уведомлений — это и есть тумблер на телефоне,
          // где попап расширения открыть практически невозможно.
          navigator.mediaSession.setActionHandler('pause', () => {
            console.log('[Flow] Keepalive выключен из шторки');
            flowSetKeepaliveEnabled(false);
            _flowAudio.pause();
          });
          navigator.mediaSession.setActionHandler('play', () => {
            console.log('[Flow] Keepalive включён из шторки');
            flowSetKeepaliveEnabled(true);
            _flowAudio.play().catch(() => {});
          });
        } catch {}
        return true;
      })
      .catch(() => false);

    // Пробуем сразу; если автовоспроизведение запрещено — ждём касания
    if (await tryPlay()) return;

    const onGesture = async () => {
      if (await tryPlay()) {
        document.removeEventListener('click', onGesture, true);
        document.removeEventListener('touchstart', onGesture, true);
      }
    };
    document.addEventListener('click', onGesture, true);
    document.addEventListener('touchstart', onGesture, true);
    document.addEventListener('visibilitychange', () => { if (!_flowUserPaused) tryPlay(); });
  } catch (e) {
    console.error('[Flow] Звуковой keepalive не запустился:', e);
  }
}
