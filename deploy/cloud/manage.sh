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
  set-admin-password)
    exec 9>/var/lock/texhoru-deploy.lock
    flock -n 9 || { echo 'Установка или обновление уже идёт.'; exit 1; }
    email=${2:-$(sed -n 's/^ADMIN_EMAIL=//p' /etc/texhoru/app.env | tail -1)}
    [[ $email =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$ ]] || { echo 'Укажи email: sudo texhoru set-admin-password EMAIL'; exit 1; }
    email=${email,,}
    read -r -s -p 'Новый пароль (от 16 символов): ' password; printf '\n'
    read -r -s -p 'Повтори новый пароль: ' repeated; printf '\n'
    [[ $password == "$repeated" ]] || { echo 'Пароли не совпадают. Ничего не изменено.'; exit 1; }
    [[ ${#password} -ge 16 ]] || { echo 'Нужно не меньше 16 символов. Ничего не изменено.'; exit 1; }
    umask 077
    temporary=$(mktemp /etc/texhoru/.password-XXXXXX)
    trap 'rm -f "$temporary"; unset password repeated' EXIT
    while IFS= read -r line || [[ -n $line ]]; do
      case "$line" in
        ADMIN_PASSWORD=*) ;;
        ADMIN_EMAIL=*) ;;
        *) printf '%s\n' "$line" ;;
      esac
    done < /etc/texhoru/app.env > "$temporary"
    printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$email" "$password" >> "$temporary"
    # Works with an already installed image: no rebuild or site downtime.
    printf '%s\0%s' "$email" "$password" | "${compose[@]}" exec -T app node -e "$(cat deploy/cloud/set-admin-password.cjs)"
    if ! mv -f "$temporary" /etc/texhoru/app.env; then
      echo 'Пароль в базе уже изменён, но файл настроек не сохранён. Новый пароль действует; проверь права и свободное место.'
      exit 1
    fi
    unset password repeated
    echo 'Готово. Выйди из кабинета и войди новым паролем. Сайт перезапускать не нужно.' ;;
  import-catalog)
    source=$(realpath -e "${2:?Укажи папку catalog-transfer}")
    [[ -f $source/manifest.json && -f $source/catalog.json ]] || { echo 'Папка каталога не найдена.'; exit 1; }
    exec 9>/var/lock/texhoru-deploy.lock
    flock -n 9 || { echo 'Установка или обновление уже идёт.'; exit 1; }
    "${compose[@]}" stop app
    trap '"${compose[@]}" up -d --wait --wait-timeout 180' EXIT
    code=$(cat deploy/cloud/catalog-transfer.cjs)
    code+=$'\ntry { console.log("Catalog imported:", importCatalog("/transfer", "/data/texhoru.db", "/uploads")) } catch (e) { console.error(e.message); process.exitCode=1 }'
    "${compose[@]}" run --rm --no-deps --entrypoint=node --volume "$source:/transfer:ro" app -e "$code"
    chown -R 1000:1000 /var/lib/texhoru/uploads
    echo 'Товары и привязки перенесены. Облачные пользователи, пароль и ключ 1С сохранены.' ;;
  import-data)
    source=$(realpath -e "${2:?Укажи папку cloud-transfer}")
    [[ -f $source/manifest.json && -f $source/database.db ]] || { echo 'Не найдена папка переноса.'; exit 1; }
    exec 9>/var/lock/texhoru-deploy.lock
    flock -n 9 || { echo 'Установка или обновление уже идёт.'; exit 1; }
    "${compose[@]}" stop app
    trap '"${compose[@]}" up -d --wait --wait-timeout 180' EXIT
    "${compose[@]}" run --rm --no-deps --entrypoint=node --volume "$source:/transfer:ro" app /app/deploy/cloud/import.mjs
    chown -R 1000:1000 /var/lib/texhoru/uploads
    echo 'Перенос завершён. Исходная папка оставлена у владельца; автоматических бэкапов нет.' ;;
  reset-database)
    [[ ${2:-} == --keep-admin && $# -eq 2 ]] || { echo 'Удалить все данные базы кроме единственного администратора: sudo texhoru reset-database --keep-admin'; exit 1; }
    exec 9>/var/lock/texhoru-deploy.lock
    flock -n 9 || { echo 'Другая операция TEXHORU уже идёт.'; exit 1; }
    container=$("${compose[@]}" ps -q app)
    [[ -n $container ]] || { echo 'Контейнер приложения не найден.'; exit 1; }
    database_dir=$(docker inspect --format '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}' "$container")
    [[ -n $database_dir && -f $database_dir/texhoru.db ]] || { echo 'База данных не найдена.'; exit 1; }
    backup_dir=$(mktemp -d /var/backups/texhoru-reset-XXXXXXXX)
    chmod 0700 "$backup_dir"
    "${compose[@]}" stop app
    trap '"${compose[@]}" up -d --wait --wait-timeout 180' EXIT
    # Include WAL/SHM: a database file copied alone may omit committed records.
    tar -C "$database_dir" -cpf "$backup_dir/database.tar" .
    chmod 0600 "$backup_dir/database.tar"
    echo "Резервная копия: $backup_dir/database.tar"
    code=$(cat deploy/cloud/reset-database.cjs)
    code+=$'\ntry { console.log(JSON.stringify(resetDatabase("/data/texhoru.db"), null, 2)) } catch (e) { console.error(e.message); process.exitCode=1 }'
    "${compose[@]}" run --rm --no-deps -T --entrypoint=node app -e "$code"
    echo 'База очищена. Администратор и его пароль сохранены. Файлы загрузок и конфигурация сервера сохранены.' ;;
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
  *) echo 'Команды: status | logs | start | stop | restart | update | reset-database --keep-admin | credentials | set-admin-password [EMAIL] | import-catalog ПАПКА | import-data ПАПКА'; exit 1 ;;
esac
