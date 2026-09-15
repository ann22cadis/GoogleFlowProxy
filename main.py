import asyncio
import hashlib
import inspect
import json
import os
import secrets
import sys
import uuid
import re
import time
import random
import base64
import urllib.request
import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

class NoiseFilter(logging.Filter):
    """Служебные запросы не засоряют консоль. Итог генерации пишет сам generate_content."""
    QUIET = ("GET /health", "GET /api/ext/poll", "POST /api/ext/callback",
             "OPTIONS ", "generateContent HTTP")

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

_cors_options = dict(
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
# Новые версии Starlette сами отклоняют запрос к 127.0.0.1 с публичного сайта
# (таверна на хостинге), пока это явно не разрешено. В старых такого
# параметра нет — там заголовок ставит local_guard ниже.
if "allow_private_network" in inspect.signature(CORSMiddleware.__init__).parameters:
    _cors_options["allow_private_network"] = True
app.add_middleware(CORSMiddleware, **_cors_options)

EXTENSION_ORIGINS = ("chrome-extension://", "moz-extension://")


@app.middleware("http")
async def local_guard(request: Request, call_next):
    # sillyimages ходит к прокси прямо из браузера, поэтому CORS открыт. Но
    # тогда и любой открытый сайт мог бы читать /api/ext/poll — промпты и
    # референсы из очереди. Расширение приходит со своим origin или без него,
    # а обычная страница всегда присылает свой.
    if request.url.path.startswith("/api/ext/"):
        origin = request.headers.get("origin")
        if origin and not origin.startswith(EXTENSION_ORIGINS):
            return JSONResponse({"error": "forbidden"}, status_code=403)

    response = await call_next(request)

    # Chromium спрашивает явное разрешение, когда сайт с чужого сервера
    # (например, таверна на хостинге) обращается к 127.0.0.1
    if request.headers.get("access-control-request-private-network") == "true":
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


# ─── Ключ доступа к прокси ────────────────────────────────────
# Работает как пароль: без него любой сайт, открытый в том же браузере, мог
# бы генерировать картинки на вашем аккаунте Google.

KEY_FILE = "proxy_key.txt"
MIN_KEY_LENGTH = 12


def load_proxy_key() -> str | None:
    key = os.environ.get("FLOW_PROXY_KEY", "").strip()
    if key:
        return key
    try:
        with open(KEY_FILE, encoding="utf-8") as f:
            return f.read().strip() or None
    except FileNotFoundError:
        return None


def ask_proxy_key() -> str | None:
    """Первый запуск: просим придумать ключ. Без терминала (pm2 и т.п.) не спрашиваем."""
    if not sys.stdin.isatty():
        return None
    print("\n[КЛЮЧ] Придумайте ключ доступа к прокси — он работает как пароль.")
    print("[КЛЮЧ] Его нужно будет вписать в SillyTavern в поле «API ключ».")
    entered = input("[КЛЮЧ] Ваш ключ (Enter — сгенерировать случайный): ").strip()
    key = entered or secrets.token_urlsafe(24)
    with open(KEY_FILE, "w", encoding="utf-8") as f:
        f.write(key)
    print(f"[КЛЮЧ] Сохранён в {KEY_FILE}: {key}\n")
    return key


PROXY_KEY = load_proxy_key()


def check_proxy_key(request: Request) -> JSONResponse | None:
    """None — ключ подходит (или не задан), иначе готовый ответ 401."""
    if not PROXY_KEY:
        return None
    auth = request.headers.get("authorization", "")
    provided = (
        request.headers.get("x-goog-api-key")
        or (auth[7:] if auth.lower().startswith("bearer ") else "")
        or request.query_params.get("key")
        or ""
    ).strip()
    if secrets.compare_digest(provided.encode(), PROXY_KEY.encode()):
        return None
    print("[КЛЮЧ] Отклонён запрос с неверным ключом")
    return JSONResponse({"error": {
        "code": 401,
        "status": "UNAUTHENTICATED",
        "message": f"Неверный ключ прокси Flow. Впишите в SillyTavern ключ из {KEY_FILE}.",
    }}, status_code=401)

# ─────────────────────────────────────────────────────────────
#  Google переехал с labs.google/fx/tools/flow на flow.google.com и сменил
#  протокол: вместо обычного REST JSON (aisandbox-pa.googleapis.com) теперь
#  используется batchexecute — тот же RPC-протокол, что у Docs/Photos/Bard.
#
#  Тело запроса — не JSON, а form-urlencoded с полями f.req (вложенный
#  JSON-массив вида [[[rpcid, "аргументы-строкой", null, "generic"]]]) и at
#  (анти-CSRF токен страницы). Ответ — тоже не чистый JSON: префикс )]}',
#  затем чанки вида "<длина>\n<JSON-массив>".
#
#  Авторизация больше не через Bearer-токен (капture из заголовков), а через
#  обычные cookies сессии Google — поэтому сам fetch должен выполняться
#  ИЗ КОНТЕКСТА страницы flow.google.com (расширение делает это через
#  injected.js), а не напрямую из background.js расширения. URL и тело
#  batchexecute-запроса поэтому собирает само расширение (background.js) —
#  оно же знает актуальные bl/f.sid/at, пойманные из трафика страницы;
#  main.py передаёт только rpcid и аргументы вызова.
# ─────────────────────────────────────────────────────────────

# Внутренние ID RPC-вызовов Google Flow (найдены разбором HAR-лога реальной сессии)
RPC_CREATE_PROJECT = "jHPbke"
RPC_GENERATE_IMAGE = "ogiZ0b"
RPC_UPLOAD_IMAGE = "maseQ"
RPC_UPSCALE_IMAGE = "SPrCad"

CAPTCHA_PLACEHOLDER = "__CAPTCHA__"


def parse_batchexecute_response(text: str, rpcid: str):
    """
    Разбирает чанкованный ответ batchexecute.

    Формат: )]}'\\n\\n<длина>\\n<JSON-массив>\\n<длина>\\n<JSON-массив>...
    Каждый JSON-массив — это либо содержательный чанк вида
    ["wrb.fr", rpcid, "<JSON-строка-с-результатом>", ...], либо служебный
    (["di", ...], ["e", ...], ["af.httprm", ...]) — их пропускаем.
    """
    lines = text.split("\n")
    i = 0
    while i < len(lines):
        line = lines[i].strip()
        if line.isdigit():
            i += 1
            if i >= len(lines):
                break
            try:
                chunk = json.loads(lines[i])
            except Exception:
                i += 1
                continue
            for entry in chunk:
                if isinstance(entry, list) and len(entry) >= 3 and entry[0] == "wrb.fr" and entry[1] == rpcid:
                    return json.loads(entry[2])
        i += 1
    raise ValueError(f"Не нашли wrb.fr для {rpcid} в ответе batchexecute")


def _find_string_containing(obj, needle: str):
    """Рекурсивно ищет первую строку, содержащую needle, в произвольно вложенной структуре."""
    if isinstance(obj, str):
        return obj if needle in obj else None
    if isinstance(obj, list):
        for item in obj:
            found = _find_string_containing(item, needle)
            if found:
                return found
    return None


async def batch_execute(rpcid: str, args, source_path: str, captcha_action: str = "", timeout: int = 180) -> dict:
    """Отправляет один batchexecute RPC через расширение и разбирает ответ."""
    body_str = json.dumps(args)
    res = await send_to_extension("batch_execute", {
        "rpcid": rpcid,
        "argsJson": body_str,
        "sourcePath": source_path,
        "captchaAction": captcha_action,
    }, timeout=timeout)

    if res.get("error"):
        return res

    status = res.get("status")
    if isinstance(status, int) and status >= 400:
        return {"error": f"HTTP {status}: {str(res.get('data'))[:500]}", "status": status}

    raw_text = res.get("data") or ""
    try:
        parsed = parse_batchexecute_response(raw_text, rpcid)
    except Exception as e:
        return {"error": f"Не смогли разобрать ответ Google: {e}"}

    return {"result": parsed}

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

    # ── получение задачи расширением ─────────────────────────
    async def take(self, wait: float) -> dict | None:
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


# ─── Загрузка / сохранение проекта ───────────────────────────

def load_project_state() -> dict:
    try:
        with open(PROJECT_FILE) as f:
            return json.load(f)
    except Exception:
        return {}

def save_project_state():
    with open(PROJECT_FILE, "w") as f:
        json.dump({
            "project_id": active_project_id,
            "refs_workflow_id": refs_workflow_id,
            "refs_cache": refs_cache,
        }, f)

def forget_references():
    """Плитку с референсами удалили — ни она, ни загруженные в неё картинки больше не действуют."""
    global refs_workflow_id
    refs_workflow_id = None
    refs_cache.clear()
    save_project_state()

_project_state = load_project_state()
active_project_id = _project_state.get("project_id")
# Workflow (плитка в проекте), внутрь которого скрыто складываются референсы
refs_workflow_id = _project_state.get("refs_workflow_id")
# sha256 картинки -> mediaId: уже загруженный в этот проект референс не грузим заново
refs_cache: dict[str, str] = _project_state.get("refs_cache") or {}
if active_project_id:
    print(f"[API] Загрузили сохраненный проект: {active_project_id}")


async def send_to_extension(method: str, params: dict, timeout: int = 180) -> dict:
    if not await bridge.wait_online(40):
        return {"error": "Расширение не подключено к прокси (откройте браузер с расширением)"}
    return await bridge.call(method, params, timeout=timeout)


async def upload_reference_image(image_base64: str, project_id: str, filename: str, quiet: bool = False) -> str:
    """
    Загружает референсную картинку (rpcid=maseQ) и возвращает её mediaId.

    Каждая загрузка без workflowId заводит в проекте новую плитку, и флаг
    isHidden это не отменяет: он скрывает картинку только внутри своего
    workflow. Поэтому первый референс в проекте загружается обычным способом,
    а все следующие — скрытыми внутрь его workflow, как сайт делает со своими
    служебными загрузками. На весь проект остаётся одна плитка.
    """
    global refs_workflow_id
    if not quiet:
        print("[API] Загрузка референса...")

    for attempt in range(2):
        container = refs_workflow_id
        # clientContext по коду сайта: 2 инструмент (22 = PINHOLE), 5 workflowId,
        # 6 projectId, 11 reCAPTCHA
        client_ctx = [None, 22, None, None, container, project_id, None, None, None, None, [CAPTCHA_PLACEHOLDER, 1]]
        # UploadImage: 1 clientContext, 2 байты, 3 mimeType, 4 флаг (у сайта
        # всегда true), 8 isHidden, 9 имя файла, 11/12 id
        args = [client_ctx, image_base64, "image/jpeg", 1, None, None, None, 1 if container else None,
                filename, None, str(uuid.uuid4()).upper(), str(uuid.uuid4()).upper()]

        res = await batch_execute(
            RPC_UPLOAD_IMAGE, args,
            source_path=f"/project/{project_id}",
            captcha_action="UPLOAD_IMAGE",
        )

        status = res.get("status")
        rejected = (isinstance(status, int) and 400 <= status < 500) or "разобрать ответ" in str(res.get("error"))
        if container and attempt == 0 and rejected:
            # Скорее всего, плитку-контейнер удалили из проекта вручную
            print("\n[API] Плитка для референсов недоступна — заводим новую")
            forget_references()
            continue
        break

    if res.get("error"):
        err = res["error"]
        print(f"\n[API] Ошибка загрузки референса: {with_explanation(err, describe_google_error(str(err)))}")
        return None

    try:
        media_id = res["result"][0][0]
    except Exception as e:
        print(f"\n[API] Не удалось найти mediaId в ответе загрузки: {e}")
        return None

    if not container:
        workflow_id = res["result"][0][2] if len(res["result"][0]) > 2 else None
        if isinstance(workflow_id, str) and workflow_id:
            refs_workflow_id = workflow_id
            save_project_state()

    if not quiet:
        print(f"[API] Референс загружен! mediaId: {media_id}")
    return media_id


async def resolve_references(image_base64_list: list[str]) -> tuple[list[str], bool]:
    """mediaId для каждого референса: из кэша проекта или свежей загрузкой. Второе значение — был ли кэш."""
    media_ids = []
    cached_count = 0
    uploaded = 0
    total = len(image_base64_list)

    for i, img_b64 in enumerate(image_base64_list):
        key = hashlib.sha256(img_b64.encode()).hexdigest()
        cached = refs_cache.get(key)
        if cached:
            media_ids.append(cached)
            cached_count += 1
            continue

        print(f"\r[API] Загрузка референсов {i+1}/{total}... ", end="", flush=True)
        if uploaded:
            await asyncio.sleep(random.uniform(0.5, 1.5))
        mid = await upload_reference_image(img_b64, active_project_id, f"ref_{int(time.time())}_{i}.jpg", quiet=True)
        uploaded += 1
        if mid:
            refs_cache[key] = mid
            save_project_state()
            media_ids.append(mid)

    if uploaded:
        print()
        # Пауза перед генерацией (имитация живого пользователя)
        await asyncio.sleep(random.uniform(1.0, 2.5))
    if cached_count:
        print(f"[API] Референсов уже в проекте: {cached_count} из {total} — загрузку пропускаем")
    return media_ids, cached_count > 0


# Поддерживаемые Google Flow форматы: строка -> (отношение сторон, константа API)
SUPPORTED_RATIOS = {
    "16:9": (16 / 9, "IMAGE_ASPECT_RATIO_LANDSCAPE"),
    "4:3":  (4 / 3,  "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE"),
    "1:1":  (1.0,    "IMAGE_ASPECT_RATIO_SQUARE"),
    "3:4":  (3 / 4,  "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"),
    "9:16": (9 / 16, "IMAGE_ASPECT_RATIO_PORTRAIT"),
}

# В новом протоколе формат передаётся не строкой, а числом (позиция сразу
# после seed в request_item). Все пять значений подтверждены разбором живых
# HAR-запросов с разными форматами: 1->1024x1024(1:1), 2->768x1376(9:16),
# 3->1376x768(16:9), 4->896x1200(3:4), 5->1200x896(4:3).
RATIO_ENUM = {
    "IMAGE_ASPECT_RATIO_SQUARE": 1,
    "IMAGE_ASPECT_RATIO_PORTRAIT": 2,
    "IMAGE_ASPECT_RATIO_LANDSCAPE": 3,
    "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR": 4,
    "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE": 5,
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


def with_explanation(err, explanation: str) -> str:
    """Исходная ошибка и, если она известна, её пояснение — одной строкой для консоли."""
    err = str(err)
    if explanation == err:
        return err
    return f"{err.rstrip('.')}. {explanation}"


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
               "flow.google.com и убедитесь, что вы залогинены.")
        if from_iframe:
            msg += (" Токен выдал скрытый iframe — из настоящей вкладки Flow "
                    "проверка проходит надёжнее.")
        return msg

    if "failed to fetch" in low or "networkerror" in low:
        return ("Браузер оборвал запрос к Google: вкладку Flow увели в фон или пропала сеть "
                "(на телефоне — переключение между приложениями, блокировка экрана, смена "
                "Wi-Fi или VPN). Генерация могла всё же пройти — проверьте проект на "
                "flow.google.com. Пока идёт генерация, не сворачивайте браузер.")
    if "content_timeout" in low or "fetch_timeout" in low:
        return ("Google не ответил вовремя. Генерация могла всё же пройти — "
                "проверьте проект на flow.google.com, прежде чем повторять.")
    if "captcha_timeout" in low:
        return ("Страница Flow не успела выдать токен reCAPTCHA — вкладка спит. "
                "Попробуйте ещё раз.")
    if "captcha_failed" in low:
        return ("Не удалось получить токен reCAPTCHA со страницы Flow. "
                "Попробуйте ещё раз.")
    if "permission_denied" in low:
        return ("Google не дал доступ (PERMISSION_DENIED). Проверьте, что во "
                "вкладке flow.google.com вы залогинены тем аккаунтом, у которого "
                "есть доступ к Flow.")
    if "resource_exhausted" in low or "public_error_high_traffic" in low or "429" in err_str:
        return "Серверы Google перегружены (слишком много запросов). Подождите немного и повторите."
    if "no_flow_tab" in low:
        return "Нет открытой вкладки Google Flow. Откройте flow.google.com в браузере."
    if "batch_config" in low:
        return ("Расширение ещё не поймало служебные параметры страницы Flow "
                "(bl/f.sid/at). Откройте вкладку flow.google.com, дайте ей "
                "полностью загрузиться, и повторите запрос.")
    if "не подключено" in err_str or "not connected" in low:
        return "Расширение не подключено. Откройте браузер с вкладкой Google Flow."

    return err_str


@app.get("/v1/models")
@app.get("/v1beta/models")
async def get_models(request: Request):
    if denied := check_proxy_key(request):
        return denied
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


def _format_duration(seconds: float) -> str:
    seconds = round(seconds)
    if seconds < 60:
        return f"{seconds} с"
    return f"{seconds // 60} мин {seconds % 60:02d} с"


@app.post("/v1beta/models/{model}:generateContent")
async def generate_content(model: str, request: Request):
    started = time.monotonic()
    response = await _generate_content(model, request)

    status = response.status_code if isinstance(response, JSONResponse) else 200
    elapsed = _format_duration(time.monotonic() - started)
    if status < 400:
        line, color = f"УСПЕШНО · генерация заняла {elapsed}", "\033[32m"
    else:
        line, color = f"ОШИБКА {status} · через {elapsed}", "\033[31m"
    print(f"{color}{line}\033[0m" if sys.stdout.isatty() else line)
    return response


async def _generate_content(model: str, request: Request):
    if denied := check_proxy_key(request):
        return denied
    prompt = ""
    image_base64_list = []
    aspect_ratio_val = "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR" # по умолчанию
    image_size_val = None

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
        return JSONResponse({"error": {"message": "Расширение Flow не подключено! Откройте браузер с расширением и вкладкой Flow."}}, status_code=500)

    print(f"Промпт: {prompt[:150]}...")

    global active_project_id
    if not active_project_id:
        print("[API] Создание нового проекта...")
        create_res = await batch_execute(
            RPC_CREATE_PROJECT,
            ["projects/*", [None, ["SillyTavern Auto"]], [None, 22]],
            source_path="/",
        )
        if create_res.get("error"):
            print(f"[API] Ошибка создания проекта: {create_res['error']}")
            user_msg = describe_google_error(str(create_res['error']))
            return JSONResponse({"error": {"message": user_msg}}, status_code=500)

        try:
            active_project_id = create_res["result"][0]
        except Exception as e:
            print(f"[API] Ошибка парсинга проекта: {e}, ответ: {str(create_res)[:300]}")
            return JSONResponse({"error": {"message": "Failed to create project"}}, status_code=500)

        print(f"[API] Проект создан! ID: {active_project_id}")
        # Плитка и загруженные референсы принадлежали старому проекту
        forget_references()

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

    # clientContext в новом протоколе — позиционный массив вместо именованных
    # полей: [null, tool=22(PINHOLE), null, null, null, projectId, null, null,
    #         null, null, [recaptchaToken, applicationType=1(WEB)]]
    # Плейсхолдер токена капчи подставляет расширение — сам токен через
    # background.js в main.py никогда не попадает.
    client_ctx = [None, 22, None, None, None, active_project_id, None, None, None, None, [CAPTCHA_PLACEHOLDER, 1]]
    ratio_enum = RATIO_ENUM.get(aspect_ratio_val, RATIO_ENUM["IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"])

    for attempt in range(2):
        # Референсы (консистентность персонажей): уже загруженные в проект
        # берутся из кэша, новые — загружаются
        character_media_ids, used_cache = await resolve_references(image_base64_list)

        seed = random.randint(100_000_000, 999_999_999)
        # Третья позиция request_item — референсы: [[mediaId, null, null, null, 1], ...] или null
        image_inputs = [[mid, None, None, None, 1] for mid in character_media_ids] or None
        request_item = [None, None, image_inputs, seed, ratio_enum, internal_model, None, client_ctx, [[[prompt]]], None, None, None,
                         str(uuid.uuid4()).upper(), str(uuid.uuid4()).upper()]
        gen_args = [None, [request_item], 1, client_ctx, [str(uuid.uuid4()).upper()]]

        print("[API] Отправляем промпт на генерацию...")
        gen_res = await batch_execute(
            RPC_GENERATE_IMAGE,
            gen_args,
            source_path=f"/project/{active_project_id}",
            captcha_action="IMAGE_GENERATION",
        )

        # Сохранённые референсы могли пропасть (плитку с ними удалили вручную).
        # Google тогда отклоняет запрос, ничего не генерируя, — забываем кэш и
        # пробуем один раз со свежей загрузкой. Антифрод и капчу так не
        # повторяем: лишний запрос только ухудшит дело.
        err = str(gen_res.get("error") or "")
        stale_refs = (gen_res.get("status") == 400 or "разобрать ответ" in err) and not any(
            s in err.lower() for s in ("unusual", "recaptcha", "captcha", "permission"))
        if used_cache and attempt == 0 and stale_refs:
            print("[API] Google не принял сохранённые референсы — загружаем их заново")
            forget_references()
            continue
        break

    if gen_res.get("error"):
        err = gen_res["error"]
        src = gen_res.get("captchaSource")
        user_msg = describe_google_error(str(err), src)
        print(f"[API] Ошибка генерации: {with_explanation(err, user_msg)}")
        if src:
            print(f"[API] Токен reCAPTCHA выдал: {src}")
        return JSONResponse({"error": {"message": user_msg, "code": 500}}, status_code=500)

    result = gen_res.get("result")
    image_url = _find_string_containing(result, "flow-content.google/image/")
    if not image_url:
        print(f"[API-DEBUG] Картинка не найдена в ответе: {json.dumps(result, ensure_ascii=False)[:500]}")
        return JSONResponse({"error": {"message": "Картинка не вернулась. Возможно, промпт заблокирован фильтром."}}, status_code=500)

    gen_media_id = image_url.split("/image/", 1)[1].split("?", 1)[0]

    # Если просят 2K — делаем второй запрос на апскейл. Апскейл возвращает
    # картинку сразу как base64 в самом ответе, без отдельного скачивания.
    image_log = "[API] Картинка: получена"
    if image_size_val == "2K":
        # Пауза перед апскейлом (имитация живого пользователя)
        await asyncio.sleep(random.uniform(1.5, 3.0))
        print(f"{image_log} · апскейл 2K...", end="", flush=True)
        upscale_ctx = [None, 22, None, None, None, None, None, None, None, None, [CAPTCHA_PLACEHOLDER, 1]]
        upscale_res = await batch_execute(
            RPC_UPSCALE_IMAGE,
            [gen_media_id, 1, upscale_ctx],
            source_path=f"/project/{active_project_id}",
            captcha_action="IMAGE_GENERATION",
        )
        upscale_b64 = None
        if upscale_res.get("error"):
            failure = f"апскейл не удался ({upscale_res['error']})"
        else:
            try:
                upscale_b64 = upscale_res["result"][1]
                failure = "апскейл без картинки"
            except Exception as e:
                failure = f"ответ апскейла не разобрался ({e})"
        if isinstance(upscale_b64, str) and upscale_b64:
            print(f"\r{image_log} · апскейл 2K · отправлена в SillyTavern")
            return {
                "candidates": [{
                    "content": {
                        "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": upscale_b64}}],
                        "role": "model"
                    }
                }]
            }
        # Апскейл не вышел — отдаём базовую картинку
        print(f"\r{image_log} · {failure}")
        image_log = "[API] Картинка: базовая"

    print(f"{image_log} · скачивается...", end="", flush=True)
    try:
        def _download(u):
            req = urllib.request.Request(u, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req, timeout=60) as response:
                return response.read()

        img_data = await asyncio.to_thread(_download, image_url)
        enc = base64.b64encode(img_data).decode('utf-8')
        print(f"\r{image_log} · скачана · отправлена в SillyTavern")
        return {
            "candidates": [{
                "content": {
                    "parts": [{"inlineData": {"mimeType": "image/jpeg", "data": enc}}],
                    "role": "model"
                }
            }]
        }
    except Exception as e:
        print(f"\r{image_log} · не скачалась ({e}) · отправлена ссылка в SillyTavern")
        return {
            "candidates": [{
                "content": {
                    "parts": [{"text": image_url}],
                    "role": "model"
                }
            }]
        }

if __name__ == "__main__":
    import uvicorn

    if not PROXY_KEY:
        PROXY_KEY = ask_proxy_key()
    if not PROXY_KEY:
        print(f"[КЛЮЧ] ВНИМАНИЕ: ключ не задан — любой сайт в этом браузере может генерировать "
              f"на вашем аккаунте. Создайте {KEY_FILE} или переменную FLOW_PROXY_KEY.")
    elif len(PROXY_KEY) < MIN_KEY_LENGTH:
        print(f"[КЛЮЧ] Ключ короче {MIN_KEY_LENGTH} символов — его легко подобрать, лучше сменить.")

    print("[СЕРВЕР] Слушаем http://127.0.0.1:8001 — ждём расширение...")
    uvicorn.run(
        app,
        # Только это устройство: и расширение, и SillyTavern (даже на чужом
        # сервере — запросы sillyimages идут из браузера) ходят сюда локально
        host="127.0.0.1",
        port=8001,
        # keep-alive должен переживать 25-секундный long-poll расширения
        timeout_keep_alive=75,
    )
