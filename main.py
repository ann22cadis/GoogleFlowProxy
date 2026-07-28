import asyncio
import json
import uuid
import re
import time
import random
import base64
import urllib.request
import logging
from fastapi import FastAPI, WebSocket, Request
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware

class HealthEndpointFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        return record.getMessage().find("GET /health") == -1

logging.getLogger("uvicorn.access").addFilter(HealthEndpointFilter())

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/health")
async def health():
    return JSONResponse({"ok": True})

extension_ws = None
pending_requests = {}

GOOGLE_FLOW_API = "https://aisandbox-pa.googleapis.com"
GOOGLE_API_KEY = "AIzaSyBtrm0o5ab1c-Ec8ZuLcGt3oJAA5VWt3pY"

# Храним project_id на диске, чтобы не создавать новые проекты при каждом рестарте
PROJECT_FILE = "active_project.json"

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

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    global extension_ws
    await websocket.accept()
    extension_ws = websocket
    print("[WS] Расширение подключено!")
    try:
        while True:
            data = await websocket.receive_text()
            msg = json.loads(data)
            
            if msg.get("type") == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))
                continue
                
            req_id = msg.get("id")
            if req_id and req_id in pending_requests:
                if not pending_requests[req_id].done():
                    pending_requests[req_id].set_result(msg)
    except Exception as e:
        print(f"[WS] Отключено: {e}")
    finally:
        extension_ws = None
        print("[WS] Расширение отключено")


async def send_to_extension(method: str, params: dict, timeout: int = 120) -> dict:
    if not extension_ws:
        return {"error": "Расширение не подключено к прокси (откройте браузер с расширением)"}
    
    req_id = str(uuid.uuid4())
    future = asyncio.get_event_loop().create_future()
    pending_requests[req_id] = future
    
    payload = {
        "id": req_id,
        "method": method,
        "params": params
    }
    
    await extension_ws.send_text(json.dumps(payload))
    
    try:
        result = await asyncio.wait_for(future, timeout=timeout)
        return result
    except asyncio.TimeoutError:
        return {"error": "Таймаут ожидания ответа от расширения"}
    finally:
        pending_requests.pop(req_id, None)


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
    if not extension_ws:
        return JSONResponse({"error": {"message": "Расширение Flow не подключено! Откройте браузер с расширением и вкладкой Labs."}}, status_code=500)
    
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
        
        req_str = str(req_data).lower()
        format_log = ""

        # 1. Поиск запрошенного формата
        ratio_match = re.search(r'\b(\d+)[:/](\d+)\b', req_str)
        requested_ratio_str = None
        requested_ratio_val = None

        if ratio_match:
            w, h = float(ratio_match.group(1)), float(ratio_match.group(2))
            if h > 0:
                requested_ratio_val = w / h
                requested_ratio_str = f"{int(w)}:{int(h)}"

        # 2. Поддерживаемые форматы Google Flow
        supported_ratios = {
            "16:9": (16/9, "IMAGE_ASPECT_RATIO_LANDSCAPE"),
            "4:3":  (4/3,  "IMAGE_ASPECT_RATIO_LANDSCAPE_FOUR_THREE"),
            "1:1":  (1.0,  "IMAGE_ASPECT_RATIO_SQUARE"),
            "3:4":  (3/4,  "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"),
            "9:16": (9/16, "IMAGE_ASPECT_RATIO_PORTRAIT")
        }

        if requested_ratio_val is not None:
            # Находим ближайший поддерживаемый формат
            closest_format = min(supported_ratios.keys(), key=lambda k: abs(supported_ratios[k][0] - requested_ratio_val))
            aspect_ratio_val = supported_ratios[closest_format][1]

            if requested_ratio_str not in supported_ratios:
                format_log = f"{closest_format} (ближайший к {requested_ratio_str})"
            else:
                format_log = closest_format
        else:
            # Fallback для текстовых слов
            if "landscape" in req_str or "wide" in req_str:
                aspect_ratio_val = "IMAGE_ASPECT_RATIO_WIDE"
                format_log = "16:9 (по слову)"
            elif "square" in req_str:
                aspect_ratio_val = "IMAGE_ASPECT_RATIO_SQUARE"
                format_log = "1:1 (по слову)"
            else:
                aspect_ratio_val = "IMAGE_ASPECT_RATIO_PORTRAIT_THREE_FOUR"
                format_log = "3:4 (по умолчанию)"

        print(f"[API] Запрошен размер: {image_size_val or 'базовый'}, формат: {format_log}")

        parts = req_data["contents"][0]["parts"]
        for part in parts:
            if "text" in part:
                prompt = part["text"]
            elif "inlineData" in part:
                image_base64_list.append(part["inlineData"]["data"])
    except KeyError:
        return JSONResponse({"error": {"message": "Invalid Gemini format"}}, status_code=400)

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
    
    if gen_res.get("error") or (isinstance(gen_res.get("data"), dict) and gen_res["data"].get("error")):
        err = gen_res.get("error") or gen_res.get("data", {}).get("error")
        print(f"[API] Ошибка генерации: {err}")
        
        # Человекочитаемые ошибки для SillyTavern
        err_str = str(err)
        if "CAPTCHA_TIMEOUT" in err_str:
            user_msg = "Капча не решилась (вкладка браузера уснула). Попробуйте ещё раз."
        elif "CAPTCHA_FAILED" in err_str:
            user_msg = "Капча не решилась. Попробуйте ещё раз."
        elif "UNUSUAL_ACTIVITY" in err_str or "PERMISSION_DENIED" in err_str:
            user_msg = "Google заблокировал запрос (подозрение на бота). Подождите пару минут и попробуйте снова."
        elif "RESOURCE_EXHAUSTED" in err_str or "PUBLIC_ERROR_HIGH_TRAFFIC" in err_str or "429" in err_str:
            user_msg = "Серверы Google перегружены (слишком много запросов). Подождите немного и повторите."
        elif "NO_FLOW_TAB" in err_str:
            user_msg = "Нет открытой вкладки Google Labs. Откройте labs.google/fx/tools/flow в браузере."
        elif "не подключено" in err_str or "not connected" in err_str.lower():
            user_msg = "Расширение не подключено. Откройте браузер с вкладкой Google Labs."
        else:
            user_msg = err_str
        
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
        # Скачиваем картинку напрямую через Python
        try:
            req = urllib.request.Request(fife_url, headers={'User-Agent': 'Mozilla/5.0'})
            with urllib.request.urlopen(req) as response:
                img_data = response.read()
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
    uvicorn.run(app, host="0.0.0.0", port=8001)
