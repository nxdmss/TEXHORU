#!/usr/bin/env bash
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo 'Используй sudo texhoru ...'; exit 1; }
cd /opt/texhoru
compose=(docker compose --env-file /etc/texhoru/compose.env -f deploy/cloud/compose.yaml)
case "${1:-status}" in
  status) "${compose[@]}" ps; df -h /var/lib/texhoru ;;
  logs) "${compose[@]}" logs --tail 80 app caddy ;;
  restart) "${compose[@]}" restart app caddy ;;
  stop) "${compose[@]}" stop ;;
  start) "${compose[@]}" up -d --wait --wait-timeout 180 ;;
  credentials)
    echo 'Локальные секреты сервера. Не отправляй этот вывод в чат или GitHub.'
    awk -F= '/^(ADMIN_EMAIL|ADMIN_PASSWORD|ONE_C_API_KEY)=/' /etc/texhoru/app.env ;;
  import-data)
    source=$(realpath -e "${2:?Укажи папку cloud-transfer}")
    [[ -f $source/manifest.json && -f $source/database.db ]] || { echo 'Не найдена папка переноса.'; exit 1; }
    exec 9>/var/lock/texhoru-deploy.lock
    flock -n 9 || { echo 'Установка или обновление уже идёт.'; exit 1; }
    "${compose[@]}" stop app
    trap '"${compose[@]}" up -d --wait --wait-timeout 180' EXIT
    "${compose[@]}" run --rm --no-deps --user=0 --entrypoint=node --volume "$source:/transfer:ro" app /app/deploy/cloud/import.mjs
    chown -R 1000:1000 /var/lib/texhoru/uploads
    echo 'Перенос завершён. Исходная папка оставлена у владельца; автоматических бэкапов нет.' ;;
  update)
    exec 9>/var/lock/texhoru-deploy.lock
    flock -n 9 || { echo 'Обновление уже идёт.'; exit 1; }
    [[ -z $(git status --porcelain) ]] || { echo 'Есть локальные изменения. Обновление остановлено.'; exit 1; }
    git fetch origin main
    git merge --ff-only origin/main
    export TEXHORU_RELEASE
    TEXHORU_RELEASE=$(git rev-parse --short=12 HEAD)
    "${compose[@]}" build app
    "${compose[@]}" up -d --wait --wait-timeout 180
    sed -i "s/^TEXHORU_RELEASE=.*/TEXHORU_RELEASE=$TEXHORU_RELEASE/" /etc/texhoru/compose.env
    # Keep two application images; never prune volumes, database or uploads.
    docker image ls texhoru --format '{{.ID}}' | awk '!seen[$0]++' | tail -n +3 | xargs -r docker image rm || echo 'Неиспользуемые образы пока сохранены.'
    # This installer targets a dedicated TEXHORU VM. Only unused build cache,
    # never container volumes or database files, is eligible here.
    docker builder prune --force --filter until=24h --keep-storage 1GB || echo 'Очистка кэша сборки отложена.'
    echo 'Обновлено. Проверить: sudo texhoru status' ;;
  *) echo 'Команды: status | logs | start | stop | restart | update | credentials | import-data ПАПКА'; exit 1 ;;
esac
