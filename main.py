import asyncio
import json
import uuid
import re
import time
import random
import base64
import urllib.request
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

class NoiseFilter(logging.Filter):
    """Служебные эндпоинты опрашиваются постоянно — не засоряем консоль."""
    QUIET = ("GET /health", "GET /api/ext/poll", "POST /api/ext/callback")

    def filter(self, record: logging.LogRecord) -> bool:
        msg = record.getMessage()
        return not any(q in msg for q in self.QUIET)

logging.getLogger("uvicorn.access").addFilter(NoiseFilter())


@asynccontextmanager
async def lifespan(_app: FastAPI):
    task = asyncio.create_task(bridge.watchdog())
    yield
    task.cancel()


app = FastAPI(lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

GOOGLE_FLOW_API = "https://aisandbox-pa.googleapis.com"
GOOGLE_API_KEY = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"

# Храним project_id на диске, чтобы не создавать новые проекты при каждом рестарте
PROJECT_FILE = "active_project.json"

# ─────────────────────────────────────────────────────────────
#  Мост до расширения
#
#  На Android держать постоянный WebSocket невозможно: система замораживает
#  и убивает Service Worker расширения каждый раз, когда пользователь уходит
#  из браузера. Поэтому основной транспорт — очередь задач + long-poll:
#
#    1. Запрос из SillyTavern кладётся в очередь и ЖДЁТ расширение.
#    2. Расширение висит на GET /api/ext/poll (до 25 секунд) и забирает задачу.
#    3. Расширение сразу шлёт ack, потом результат на POST /api/ext/callback.
#
#  Если расширение умерло между выдачей задачи и ack — задача возвращается
#  в очередь и уедет следующему поллеру. Ничего не теряется, SillyTavern
#  просто ждёт чуть дольше вместо ошибки "расширение не подключено".
#
#  WebSocket оставлен как второй потребитель той же очереди (десктоп).
# ─────────────────────────────────────────────────────────────

POLL_WAIT_MAX = 25.0      # сколько держим long-poll открытым
ACK_TIMEOUT = 15.0        # нет ack за это время — расширение умерло, отдаём задачу заново
ONLINE_WINDOW = 60.0      # столько секунд после последнего контакта считаем расширение живым
MAX_ATTEMPTS = 3          # сколько раз повторно выдаём одну задачу


class ExtensionBridge:
    def __init__(self):
        self.queue: asyncio.Queue = asyncio.Queue()
        self.pending: dict[str, asyncio.Future] = {}
        self.jobs: dict[str, dict] = {}
        self.delivered: dict[str, float] = {}
        self.acked: set[str] = set()
        self.attempts: dict[str, int] = {}
        self.last_seen = 0.0
        self.ws: WebSocket | None = None
        self._online = False

    # ── состояние ────────────────────────────────────────────
    def is_online(self) -> bool:
        return (time.time() - self.last_seen) < ONLINE_WINDOW

    def touch(self, source: str = "poll"):
        self.last_seen = time.time()
        if not self._online:
            self._online = True
            print(f"[МОСТ] Расширение подключено ({source})")

    def mark_offline(self):
        if self._online:
            self._online = False
            print("[МОСТ] Расширение пропало со связи (ждём возвращения)")

    async def wait_online(self, timeout: float) -> bool:
        deadline = time.monotonic() + timeout
        warned = False
        while time.monotonic() < deadline:
            if self.is_online():
                return True
            if not warned:
                warned = True
                print("[МОСТ] Расширение сейчас не на связи — ждём, пока браузер проснётся...")
            await asyncio.sleep(0.5)
        return self.is_online()

    # ── отправка задачи ──────────────────────────────────────
    async def call(self, method: str, params: dict, timeout: float = 180) -> dict:
        req_id = str(uuid.uuid4())
        self.jobs[req_id] = {"id": req_id, "method": method, "params": params}
        self.attempts[req_id] = 0
        future = asyncio.get_running_loop().create_future()
        self.pending[req_id] = future
        await self.queue.put(req_id)

        try:
            return await asyncio.wait_for(asyncio.shield(future), timeout=timeout)
        except asyncio.TimeoutError:
            return {"error": "Таймаут ожидания ответа от расширения"}
        finally:
            self._forget(req_id)

    def _forget(self, req_id: str):
        self.pending.pop(req_id, None)
        self.jobs.pop(req_id, None)
        self.delivered.pop(req_id, None)
        self.attempts.pop(req_id, None)
        self.acked.discard(req_id)

    # ── получение задачи потребителем (poll или ws) ──────────
    async def take(self, wait: float, transport: str = "poll") -> dict | None:
        deadline = time.monotonic() + wait
        while True:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            try:
                req_id = await asyncio.wait_for(self.queue.get(), timeout=remaining)
            except asyncio.TimeoutError:
                return None

            job = self.jobs.get(req_id)
            # Запрос уже успел завершиться или отвалиться по таймауту — пропускаем
            if job is None or req_id not in self.pending:
                continue

            self.delivered[req_id] = time.time()
            self.attempts[req_id] = self.attempts.get(req_id, 0) + 1
            if transport == "ws":
                # Старые сборки расширения не умеют слать ack. Считаем задачу
                # подтверждённой сразу, иначе watchdog выдал бы её повторно
                # и картинка сгенерировалась бы дважды.
                self.acked.add(req_id)
            return job

    # ── ответ от расширения ──────────────────────────────────
    def resolve(self, msg: dict) -> bool:
        req_id = msg.get("id")
        if not req_id:
            return False
        if msg.get("ack"):
            # Расширение взяло задачу в работу — повторно её не выдаём,
            # иначе можно два раза сгенерировать картинку и сжечь квоту.
            self.acked.add(req_id)
            return True
        future = self.pending.get(req_id)
        if future and not future.done():
            future.set_result(msg)
        return True

    # ── возврат потерянных задач в очередь ───────────────────
    async def watchdog(self):
        while True:
            await asyncio.sleep(5)
            now = time.time()

            if self._online and not self.is_online():
                self.mark_offline()

            for req_id, sent_at in list(self.delivered.items()):
                if req_id in self.acked or req_id not in self.pending:
                    continue
                if now - sent_at < ACK_TIMEOUT:
                    continue
                if self.attempts.get(req_id, 0) >= MAX_ATTEMPTS:
                    continue
                # Задачу выдали, но расширение её не подтвердило: браузер
                # усыпили ровно в этот момент. К Google ничего не ушло —
                # безопасно отдать задачу заново.
                self.delivered.pop(req_id, None)
                print("[МОСТ] Расширение уснуло, не забрав задачу — возвращаем её в очередь")
                await self.queue.put(req_id)


bridge = ExtensionBridge()


@app.get("/health")
async def health():
    return JSONResponse({"ok": True, "extension": bridge.is_online()})


# ─── Long-poll транспорт (основной для Android) ──────────────

@app.get("/api/ext/poll")
async def ext_poll(wait: float = POLL_WAIT_MAX):
    bridge.touch("long-poll")
    job = await bridge.take(min(max(wait, 1.0), POLL_WAIT_MAX))
    bridge.touch("long-poll")
    return JSONResponse({"jobs": [job] if job else []})


@app.post("/api/ext/callback")
async def ext_callback(request: Request):
    bridge.touch("callback")
    try:
        msg = await request.json()
    except Exception:
        return JSONResponse({"ok": False, "error": "bad json"}, status_code=400)
    bridge.resolve(msg)
    return JSONResponse({"ok": True})


# ─── WebSocket (второй потребитель той же очереди, для десктопа) ───

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()
    bridge.ws = websocket
    bridge.touch("websocket")

    async def pump_jobs():
        """Забирает задачи из общей очереди и шлёт их в сокет."""
        while True:
            job = await bridge.take(POLL_WAIT_MAX, transport="ws")
            if job is None:
                continue
            await websocket.send_text(json.dumps(job))

    pump = asyncio.create_task(pump_jobs())
    try:
        while True:
            data = await websocket.receive_text()
            bridge.touch("websocket")
            msg = json.loads(data)

            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue

            bridge.resolve(msg)
    except Exception as e:
        print(f"[WS] Отключено: {e}")
    finally:
        pump.cancel()
        # ВАЖНО: обнуляем сокет, только если он всё ещё наш. Иначе при
        # переподключении с телефона старый обработчик затирает новый.
        if bridge.ws is websocket:
            bridge.ws = None


# ─── Загрузка / сохранение проекта ───────────────────────────

def load_project_id():
    try:
        with open(PROJECT_FILE) as f:
            return json.load(f).get("project_id")
    except:
        return None

def save_project_id(pid):
    with open(PROJECT_FILE, "w") as f:
        json.dump({"project_id": pid}, f)

active_project_id = load_project_id()
if active_project_id:
    print(f"[API] Загрузили сохраненный проект: {active_project_id}")


async def send_to_extension(method: str, params: dict, timeout: int = 180) -> dict:
    if not await bridge.wait_online(40):
        return {"error": "Расширение не подключено к прокси (откройте браузер с расширением)"}
    return await bridge.call(method, params, timeout=timeout)


async def upload_reference_image(image_base64: str, quiet: bool = False) -> str:
    """Загружает картинку и возвращает mediaId."""
    if not quiet:
        print("[API] Загрузка референса...")
    body = {
        "clientContext": {"tool": "PINHOLE"},
        "fileName": f"ref_{int(time.time())}.jpg",
        "imageBytes": image_base64,
        "isHidden": False,
        "isUserUploaded": True,
        "mimeType": "image/jpeg",
    }

    url = f"{GOOGLE_FLOW_API}/v1/flow/uploadImage?key={GOOGLE_API_KEY}"
    res = await send_to_extension("api_request", {
        "url": url,
        "method": "POST",
        "headers": {"content-type": "application/json"},
        "body": body,
        "captchaAction": ""
    })

    if res.get("error"):
        print(f"\n[API] Ошибка загрузки референса: {res['error']}")
        return None

    data = res.get("data", {})
    if isinstance(data, dict):
        media = data.get("media", {})
        if isinstance(media, dict) and media.get("name"):
            if not quiet:
                print(f"[API] Референс загружен! mediaId: {media['name']}")
            return media["name"]

    print(f"\n[API] Не удалось найти mediaId в ответе загрузки.")
    return None


# Поддерживаемые Google Flow форматы: строка -> (отношение сторон, константа API)
SUPPORTED_RATIOS = {
    "16:9": (16 / 9, "IMAGE_ASPECT_RATIO_LANDSCAPE"),
    "4:3":  (4 / 3,  "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE"),
    "1:1":  (1.0,    "IMAGE_ASPECT_RATIO_SQUARE"),
    "3:4":  (3 / 4,  "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"),
    "9:16": (9 / 16, "IMAGE_ASPECT_RATIO_PORTRAIT"),
}

RATIO_RE = re.compile(r'\b(\d{1,2})\s*[:/]\s*(\d{1,2})\b')


def _map_ratio(w: float, h: float):
    """Подбирает ближайший поддерживаемый формат."""
    if h <= 0:
        return None
    value = w / h
    closest = min(SUPPORTED_RATIOS, key=lambda k: abs(SUPPORTED_RATIOS[k][0] - value))
    asked = f"{int(w)}:{int(h)}"
    label = closest if asked == closest else f"{closest} (ближайший к {asked})"
    return SUPPORTED_RATIOS[closest][1], label


def extract_aspect_ratio(req_data: dict, prompt: str):
    """
    Определяет формат картинки.

    ВАЖНО: раньше формат искали регуляркой по str(req_data), то есть по всему
    запросу целиком — вместе с base64 референсных картинок. В мегабайтах base64
    почти всегда попадается что-нибудь вроде "/123/456/", и формат брался
    оттуда. Из-за этого при генерации С РЕФЕРЕНСАМИ вместо запрошенного 16:9
    прилетал случайный формат — чаще всего 3:4. Теперь смотрим только на
    явные поля запроса и на текст промпта.
    """
    generation_config = req_data.get("generationConfig") or {}
    image_config = generation_config.get("imageConfig") or {}

    # 1. Явное поле — самый надёжный источник
    for candidate in (
        image_config.get("aspectRatio"), image_config.get("aspect_ratio"),
        generation_config.get("aspectRatio"), generation_config.get("aspect_ratio"),
        req_data.get("aspectRatio"), req_data.get("aspect_ratio"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            m = RATIO_RE.search(candidate)
            if m:
                mapped = _map_ratio(float(m.group(1)), float(m.group(2)))
                if mapped:
                    return mapped[0], f"{mapped[1]} — из поля запроса"

    # 2. Формат, записанный в самом промпте
    if prompt:
        m = RATIO_RE.search(prompt)
        if m:
            mapped = _map_ratio(float(m.group(1)), float(m.group(2)))
            if mapped:
                return mapped[0], f"{mapped[1]} — из текста промпта"

        # 3. Словами
        low = prompt.lower()
        if "landscape" in low or "widescreen" in low or "horizontal" in low:
            return SUPPORTED_RATIOS["16:9"][1], "16:9 — по слову в промпте"
        if "square" in low:
            return SUPPORTED_RATIOS["1:1"][1], "1:1 — по слову в промпте"
        if "portrait" in low or "vertical" in low:
            return SUPPORTED_RATIOS["3:4"][1], "3:4 — по слову в промпте"

    return SUPPORTED_RATIOS["3:4"][1], "3:4 — по умолчанию"


def describe_google_error(err_str: str, captcha_source: str | None = None) -> str:
    """
    Человекочитаемая ошибка для SillyTavern.

    Про формулировки. reCAPTCHA у Flow невидимая (Enterprise в score-режиме):
    картинок и чекбокса не существует, страница просто молча выдаёт токен, а
    Google выставляет ему оценку у себя. Решать пользователю нечего, поэтому
    «капча не решилась» — неверная формулировка в любом из случаев ниже.
    Расширение делает ровно то же, что и сам сайт: просит у страницы токен.

    Отсюда три разных исхода, которые раньше сливались в один:

    1. `UNUSUAL_ACTIVITY` — антифрод Google. Токен получен и принят, забракован
       IP, браузер или темп запросов. Ни капча, ни авторизация тут ни при чём.
    2. `reCAPTCHA evaluation failed` без unusual activity — Google не принял
       токен: оценка низкая или протухла сессия страницы.
    3. `CAPTCHA_TIMEOUT` / `CAPTCHA_FAILED` — до Google дело вообще не дошло,
       токен не удалось получить со страницы Labs (вкладка спит на Android).

    UNUSUAL_ACTIVITY проверяется первым, потому что Google часто отдаёт его
    внутри 403 с текстом про reCAPTCHA — и раньше срабатывала ветка про капчу.
    """
    low = err_str.lower()
    from_iframe = bool(captcha_source) and "iframe" in captcha_source

    if "unusual_activity" in low or "unusual activity" in low:
        return "Google отклонил запрос: подозрительная активность (UNUSUAL_ACTIVITY)."

    if "recaptcha evaluation failed" in low:
        msg = ("Google не принял токен reCAPTCHA. Откройте вкладку "
               "labs.google/fx/tools/flow и убедитесь, что вы залогинены.")
        if from_iframe:
            msg += (" Токен выдал скрытый iframe — из настоящей вкладки Labs "
                    "проверка проходит надёжнее.")
        return msg

    if "captcha_timeout" in low:
        return ("Страница Labs не успела выдать токен reCAPTCHA — вкладка спит. "
                "Попробуйте ещё раз.")
    if "captcha_failed" in low:
        return ("Не удалось получить токен reCAPTCHA со страницы Labs. "
                "Попробуйте ещё раз.")
    if "permission_denied" in low:
        return ("Google не дал доступ (PERMISSION_DENIED). Проверьте, что во "
                "вкладке labs.google вы залогинены тем аккаунтом, у которого "
                "есть доступ к Flow.")
    if "resource_exhausted" in low or "public_error_high_traffic" in low or "429" in err_str:
        return "Серверы Google перегружены (слишком много запросов). Подождите немного и повторите."
    if "no_flow_tab" in low:
        return "Нет открытой вкладки Google Labs. Откройте labs.google/fx/tools/flow в браузере."
    if "не подключено" in err_str or "not connected" in low:
        return "Расширение не подключено. Откройте браузер с вкладкой Google Labs."

    return err_str


@app.get("/v1/models")
@app.get("/v1beta/models")
async def get_models():
    models = [
        {"id": "nano-banana-pro", "name": "models/nano-banana-pro", "displayName": "Nano Banana Pro", "object": "model", "owned_by": "google"},
        {"id": "nano-banana-2", "name": "models/nano-banana-2", "displayName": "Nano Banana 2", "object": "model", "owned_by": "google"},
        {"id": "nano-banana-2-lite", "name": "models/nano-banana-2-lite", "displayName": "Nano Banana 2 Lite", "object": "model", "owned_by": "google"},
    ]
    return {
        "object": "list",
        "data": models,
        "models": models
    }


@app.post("/v1beta/models/{model}:generateContent")
async def generate_content(model: str, request: Request):
    prompt = ""
    image_base64_list = []
    aspect_ratio_val = "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR" # по умолчанию
    image_size_val = None
    character_media_ids = []

    try:
        req_data = await request.json()
        print(f"\n{'='*60}")
        print("[API] Получен запрос")

        # Парсим imageSize (например, "2K")
        if "generationConfig" in req_data and "imageConfig" in req_data["generationConfig"]:
            image_size_val = req_data["generationConfig"]["imageConfig"].get("imageSize")

        # Сначала достаём промпт и референсы...
        parts = req_data["contents"][0]["parts"]
        for part in parts:
            if "text" in part:
                prompt = part["text"]
            elif "inlineData" in part:
                image_base64_list.append(part["inlineData"]["data"])

        # ...и только потом определяем формат — по полям запроса и тексту
        # промпта, но НИКОГДА не по base64 референсов.
        aspect_ratio_val, format_log = extract_aspect_ratio(req_data, prompt)
        print(f"[API] Запрошен размер: {image_size_val or 'базовый'}, формат: {format_log}")
    except KeyError:
        return JSONResponse({"error": {"message": "Invalid Gemini format"}}, status_code=400)

    # Ждём расширение до 40 секунд вместо мгновенной ошибки: на Android
    # браузер мог просто уснуть и вот-вот вернётся.
    if not await bridge.wait_online(40):
        return JSONResponse({"error": {"message": "Расширение Flow не подключено! Откройте браузер с расширением и вкладкой Labs."}}, status_code=500)

    print(f"Промпт: {prompt[:150]}...")

    # 1. Загружаем референсы
    character_media_ids = []
    total_refs = len(image_base64_list)
    if total_refs > 0:
        for i, img_b64 in enumerate(image_base64_list):
            print(f"\r[API] Загрузка референсов {i+1}/{total_refs}... ", end="", flush=True)
            if i > 0:
                delay = random.uniform(0.5, 1.5)
                await asyncio.sleep(delay)
            mid = await upload_reference_image(img_b64, quiet=True)
            if mid:
                character_media_ids.append(mid)
        print() # перенос строки после всех референсов

    # Пауза перед генерацией (имитация живого пользователя)
    if character_media_ids:
        delay = random.uniform(1.0, 2.5)
        await asyncio.sleep(delay)

    global active_project_id
    if not active_project_id:
        print("[API] Создание нового проекта...")
        trpc_url = "https://labs.google/fx/api/trpc/project.createProject"
        trpc_body = {"json": {"projectTitle": "SillyTavern Auto", "toolName": "PINHOLE"}}
        p_res = await send_to_extension("trpc_request", {
            "url": trpc_url,
            "method": "POST",
            "headers": {"content-type": "application/json", "accept": "*/*"},
            "body": trpc_body
        })

        if p_res.get("error"):
            print(f"[API] Ошибка создания проекта: {p_res['error']}")
            return JSONResponse({"error": {"message": p_res['error']}}, status_code=500)

        try:
            # Ответ от trpc_request обернут в {data: {result: {data: {json: {projectId: ...}}}}}
            p_data = p_res.get("data", {})
            if isinstance(p_data, str):
                p_data = json.loads(p_data)
            # Парсим ответ

            # Пробуем найти projectId в разных местах
            if isinstance(p_data, list) and len(p_data) > 0:
                active_project_id = p_data[0]["result"]["data"]["json"].get("result", {}).get("projectId")
            elif "result" in p_data:
                # В текущей версии API: p_data["result"]["data"]["json"]["result"]["projectId"]
                json_part = p_data["result"].get("data", {}).get("json", {})
                active_project_id = json_part.get("result", {}).get("projectId") or json_part.get("projectId")
            elif "projectId" in p_data:
                active_project_id = p_data["projectId"]
            else:
                active_project_id = p_data.get("id") # fallback

            print(f"[API] Проект создан! ID: {active_project_id}")
            save_project_id(active_project_id)
        except Exception as e:
            print(f"[API] Ошибка парсинга проекта: {e}")
            return JSONResponse({"error": {"message": "Failed to create project"}}, status_code=500)

    # 2. Формируем запрос на генерацию
    ts = int(time.time() * 1000)
    session_jitter = random.randint(100, 9999)
    ctx = {
        "projectId": active_project_id,
        "recaptchaContext": {
            "applicationType": "RECAPTCHA_APPLICATION_TYPE_WEB",
            "token": "",
        },
        "sessionId": f";{ts + session_jitter}",
        "tool": "PINHOLE",
        "userPaygateTier": "PAYGATE_TIER_TWO"
    }

    # Поддержка разных моделей, приходящих из SillyTavern
    # Настоящие внутренние названия из Google Labs
    internal_model = "GEM_PIX_2"  # Nano Banana Pro
    m_str = model.lower()
    if "lite" in m_str:
        internal_model = "HARBOR_SEAL"  # Nano Banana 2 Lite
    elif "2" in m_str:
        internal_model = "NARWHAL"  # Nano Banana 2
    elif "pro" in m_str:
        internal_model = "GEM_PIX_2"  # Nano Banana Pro

    request_item = {
        "clientContext": ctx,
        "seed": random.randint(100000, 999999),
        "structuredPrompt": {"parts": [{"text": prompt}]},
        "imageAspectRatio": aspect_ratio_val,
        "imageModelName": internal_model,
    }

    if character_media_ids:
        request_item["imageInputs"] = [
            {"name": mid, "imageInputType": "IMAGE_INPUT_TYPE_REFERENCE"}
            for mid in character_media_ids
        ]

    batch_id = str(uuid.uuid4())
    body = {
        "clientContext": ctx,
        "mediaGenerationContext": {"batchId": batch_id},
        "useNewMedia": True,
        "requests": [request_item],
    }

    url = f"{GOOGLE_FLOW_API}/v1/projects/{active_project_id}/flowMedia:batchGenerateImages?key={GOOGLE_API_KEY}"
    print("[API] Отправляем промпт на генерацию...")

    gen_res = await send_to_extension("api_request", {
        "url": url,
        "method": "POST",
        "headers": {"content-type": "application/json"},
        "body": body,
        "captchaAction": "IMAGE_GENERATION"
    })

    # HTTP-статус проверяем тоже: на unusual activity Google иногда отдаёт
    # не JSON с полем error, а свою страницу-заглушку. Без этой проверки такой
    # ответ доезжал до парсера картинки и превращался в «промпт заблокирован
    # фильтром», то есть в третью неверную формулировку той же ошибки.
    gen_status = gen_res.get("status")
    http_failed = isinstance(gen_status, int) and gen_status >= 400
    if gen_res.get("error") or http_failed or (isinstance(gen_res.get("data"), dict) and gen_res["data"].get("error")):
        err = gen_res.get("error")
        if not err and isinstance(gen_res.get("data"), dict):
            err = gen_res["data"].get("error")
        if not err:
            err = f"HTTP {gen_status}: {str(gen_res.get('data'))[:500]}"
        print(f"[API] Ошибка генерации: {err}")

        # Откуда пришёл токен reCAPTCHA — на телефоне это единственный способ
        # понять, что его выдал скрытый iframe, а не вкладка Labs.
        src = gen_res.get("captchaSource")
        if src:
            print(f"[API] Токен reCAPTCHA выдал: {src}")

        user_msg = describe_google_error(str(err), src)
        return JSONResponse({"error": {"message": user_msg, "code": 500}}, status_code=500)

    # Парсим картинку прямо из ответа batchGenerateImages
    # Flow: media[0].image.generatedImage -> fifeUrl | imageUri | encodedImage
    gen_data = gen_res.get("data", {})
    if isinstance(gen_data, str):
        gen_data = json.loads(gen_data)

    media_list = gen_data.get("media", [])
    if not media_list:
        return JSONResponse({"error": {"message": "Картинка не вернулась. Возможно, промпт заблокирован фильтром."}}, status_code=500)

    # Извлекаем mediaId первой генерации
    gen_media_id = media_list[0].get("name")

    # Если просят 2K — делаем второй запрос на апскейл
    if image_size_val == "2K" and gen_media_id:
        # Пауза перед апскейлом (имитация живого пользователя)
        delay = random.uniform(1.5, 3.0)
        await asyncio.sleep(delay)
        print(f"[API] Запрошен 2K! Делаем апскейл картинки {gen_media_id}...")
        upscale_body = {
            "clientContext": ctx,
            "mediaId": gen_media_id,
            "targetResolution": "UPSAMPLE_IMAGE_RESOLUTION_2K"
        }
        upscale_url = f"{GOOGLE_FLOW_API}/v1/flow/upsampleImage?key={GOOGLE_API_KEY}"

        upscale_res = await send_to_extension("api_request", {
            "url": upscale_url,
            "method": "POST",
            "headers": {"content-type": "application/json"},
            "body": upscale_body,
            "captchaAction": "IMAGE_GENERATION"
        })

        if upscale_res.get("error") or (isinstance(upscale_res.get("data"), dict) and upscale_res["data"].get("error")) or upscale_res.get("status") == 404:
            err_msg = upscale_res.get('status') or (upscale_res.get('data') or {}).get('error') or "неизвестно"
            print(f"[API] Ошибка апскейла, возвращаем базовую картинку (ошибка: {err_msg}).")
        else:
            print("[API] Апскейл запрос прошел, проверяем ответ...")
            u_data = upscale_res.get("data", {})

            if isinstance(u_data, str) and u_data.strip():
                try:
                    u_data = json.loads(u_data)
                except Exception as e:
                    print(f"[API] Ошибка парсинга апскейла: {e}")
                    u_data = {}

            if isinstance(u_data, dict) and ("media" in u_data or "image" in u_data or "encodedImage" in u_data):
                print("[API] Успешно получили 2K картинку!")
                gen_data = u_data
                media_val = gen_data.get("media")
                if isinstance(media_val, list):
                    media_list = media_val
                elif isinstance(media_val, dict):
                    media_list = [media_val]
                else:
                    media_list = [gen_data]
            else:
                print("[API] Апскейл не вернул картинку, отдаем базовую (1x).")

    # Извлекаем картинку
    gen_image = media_list[0].get("image", {}).get("generatedImage", {}) if isinstance(media_list, list) and len(media_list) > 0 else {}
    fife_url = gen_image.get("fifeUrl") or gen_image.get("imageUri")
    encoded_b64 = gen_data.get("encodedImage") or gen_image.get("encodedImage")

    if encoded_b64:
        print(f"[API] Картинка получена как base64! Отправляем в SillyTavern.")
        return {
            "candidates": [{
                "content": {
                    "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": encoded_b64}}],
                    "role": "model"
                }
            }]
        }
    elif fife_url:
        print(f"[API] Картинка получена как URL: {fife_url[:80]}...")
        # Скачиваем картинку напрямую через Python (в отдельном потоке,
        # чтобы не блокировать event loop и не ронять long-poll расширения)
        try:
            def _download(u):
                req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
                with urllib.request.urlopen(req, timeout=60) as response:
                    return response.read()

            img_data = await asyncio.to_thread(_download, fife_url)
            enc = base64.b64encode(img_data).decode('utf-8')
            print(f"[API] Картинка успешно скачана! Отправляем в SillyTavern.")
            return {
                "candidates": [{
                    "content": {
                        "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": enc}}],
                        "role": "model"
                    }
                }]
            }
        except Exception as e:
            print(f"[API] Ошибка при скачивании картинки: {e}")
            # Если не смогли скачать — вернем url напрямую
            print(f"[API-DEBUG] Отдаем URL напрямую")
            return {
                "candidates": [{
                    "content": {
                        "parts": [{"text": fife_url}],
                        "role": "model"
                    }
                }]
            }
    else:
        print(f"[API-DEBUG] Нет картинки. gen_image: {json.dumps(gen_image, ensure_ascii=False)[:500]}")
        return JSONResponse({"error": {"message": "Картинка есть, но пикселей нет"}}, status_code=500)

if __name__ == "__main__":
    import uvicorn
    print("[СЕРВЕР] Слушаем http://127.0.0.1:8001 — ждём расширение...")
    uvicorn.run(
        app,
        host="0.0.0.0",
        port=8001,
        # keep-alive должен переживать 25-секундный long-poll расширения
        timeout_keep_alive=75,
        ws_ping_interval=25,
        ws_ping_timeout=60,
    )
