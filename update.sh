#!/bin/bash
# ╔══════════════════════════════╗
# ║  Flow — обновление (Termux)  ║
# ╚══════════════════════════════╝

echo ""
echo "┌─────────────────────────────┐"
echo "│ Flow — обновление из GitHub │"
echo "└─────────────────────────────┘"
echo ""

# Защищаем локальный файл проекта от перезаписи при pull
git update-index --skip-worktree active_project.json 2>/dev/null || true

echo "Скачиваем обновления..."
git pull

echo ""
echo "✓ Обновление завершено!"
echo ""
echo "Напоминание: на Android возьмите wake lock отдельной командой"
echo "  termux-wake-lock     — Android не будет усыплять Termux"
echo "  termux-wake-unlock   — снять, когда закончите"
echo ""
echo "Запускаем сервер..."
echo ""
python main.py
