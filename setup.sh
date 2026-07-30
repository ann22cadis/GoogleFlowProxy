#!/bin/bash
# ╔════════════════════════════════════╗
# ║  Flow — первая установка (Termux)  ║
# ╚════════════════════════════════════╝

echo ""
echo "┌───────────────────────────────┐"
echo "│ Flow — установка зависимостей │"
echo "└───────────────────────────────┘"
echo ""

# Сообщаем Git, что active_project.json — личный файл, не трогать при pull
git update-index --skip-worktree active_project.json 2>/dev/null || true

echo "[1/2] Устанавливаем библиотеки Python..."
python -m pip install --quiet fastapi uvicorn websockets httpx

echo "[2/2] Всё готово! Запускаем сервер..."
echo ""
echo "Напоминание: на Android возьмите wake lock отдельной командой"
echo "  termux-wake-lock     — Android не будет усыплять Termux"
echo "  termux-wake-unlock   — снять, когда закончите"
echo ""
python main.py
