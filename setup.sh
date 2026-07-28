#!/bin/bash
# ╔══════════════════════════════════════════╗
# ║   Flow Kit — первая установка (Termux)  ║
# ╚══════════════════════════════════════════╝

echo ""
echo "┌─────────────────────────────────┐"
echo "│  Flow Kit — установка зависимостей │"
echo "└─────────────────────────────────┘"
echo ""

# Сообщаем Git, что active_project.json — личный файл, не трогать при pull
git update-index --skip-worktree active_project.json 2>/dev/null || true

echo "[1/2] Устанавливаем библиотеки Python..."
python -m pip install --quiet fastapi uvicorn websockets httpx

echo "[2/2] Всё готово! Запускаем сервер..."
echo ""
python main.py
