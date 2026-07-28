#!/bin/bash
# ╔══════════════════════════════════════════╗
# ║   Flow Kit — обновление (Termux)        ║
# ╚══════════════════════════════════════════╝

echo ""
echo "┌─────────────────────────────────┐"
echo "│  Flow Kit — обновление из GitHub │"
echo "└─────────────────────────────────┘"
echo ""

# Защищаем локальный файл проекта от перезаписи при pull
git update-index --skip-worktree active_project.json 2>/dev/null || true

echo "Скачиваем обновления..."
git pull

echo ""
echo "✓ Обновление завершено! Запускаем сервер..."
echo ""
python main.py
