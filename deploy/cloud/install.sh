#!/usr/bin/env bash
# Run on a dedicated Ubuntu 24.04 VM, not on the Windows/1C computer.
set -euo pipefail
umask 077
[[ $EUID -eq 0 ]] || { echo 'Запусти через sudo bash install.sh'; exit 1; }
[[ -r /etc/os-release ]] || exit 1
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Нужна Ubuntu 24.04 LTS.'; exit 1; }
domain=''; email=''
while [[ $# -gt 0 ]]; do
  case "$1" in
    --domain) domain=${2:?}; shift 2 ;;
    --email) email=${2:?}; shift 2 ;;
    *) echo "Неизвестный параметр: $1"; exit 1 ;;
  esac
done
[[ -n $domain ]] || read -r -p 'Домен сайта без https://: ' domain
[[ -n $email ]] || read -r -p 'Email администратора: ' email
domain=${domain,,}
[[ $domain =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$ ]] || { echo 'Укажи корректный домен.'; exit 1; }
[[ $email =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,63}$ ]] || { echo 'Укажи корректный email.'; exit 1; }
mkdir -p /var/lock
exec 9>/var/lock/texhoru-deploy.lock
flock -n 9 || { echo 'Установка или обновление TEXHORU уже идёт.'; exit 1; }
apt-get update
apt-get install -y ca-certificates curl git openssl
if ! command -v docker >/dev/null || ! docker compose version >/dev/null 2>&1; then
  install -m 0755 -d /etc/apt/keyrings
  curl --fail --silent --show-error --retry 3 https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu noble stable\n' "$(dpkg --print-architecture)" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
systemctl enable --now docker
compose_version=$(docker compose version --short); compose_version=${compose_version#v}
[[ $(printf '%s\n' 2.30.0 "$compose_version" | sort -V | head -1) == 2.30.0 ]] || { echo 'Обнови Docker Compose до 2.30 или новее.'; exit 1; }
if [[ ! -e /opt/texhoru ]]; then
  git clone --branch main https://github.com/nxdmss/TEXHORU.git /opt/texhoru
fi
cd /opt/texhoru
[[ $(git remote get-url origin) == https://github.com/nxdmss/TEXHORU.git ]] || { echo 'В /opt/texhoru другой репозиторий.'; exit 1; }
[[ -z $(git status --porcelain) ]] || { echo 'В /opt/texhoru есть локальные изменения. Они не будут перезаписаны.'; exit 1; }
[[ $(git branch --show-current) == main ]] || { echo 'В /opt/texhoru должна быть ветка main.'; exit 1; }
git fetch origin main
git merge --ff-only origin/main
install -d -m 0700 /etc/texhoru
install -d -m 0750 /var/lib/texhoru/database /var/lib/texhoru/uploads
chown 1000:1000 /var/lib/texhoru/database /var/lib/texhoru/uploads
if [[ ! -e /etc/texhoru/app.env ]]; then
  password=$(openssl rand -hex 16)
  {
    printf 'JWT_SECRET=%s\n' "$(openssl rand -hex 32)"
    printf 'ONE_C_API_KEY=%s\n' "$(openssl rand -hex 32)"
    printf 'ADMIN_EMAIL=%s\nADMIN_PASSWORD=%s\n' "$email" "$password"
    printf 'ONE_C_BASE_KIND=TEST\nONE_C_TEST_PRICE_SYNC_ENABLED=true\nONE_C_TEST_AUTO_PRICE_SCOPE=false\n'
  } > /etc/texhoru/app.env
  unset password
fi
if [[ ! -e /etc/texhoru/compose.env ]]; then
  printf 'TEXHORU_DOMAIN=%s\nTEXHORU_RELEASE=%s\n' "$domain" "$(git rev-parse --short=12 HEAD)" > /etc/texhoru/compose.env
else
  echo 'Настройки уже существуют; домен, ключи и пароль сохранены.'
fi
chmod 0600 /etc/texhoru/*.env
cat > /usr/local/bin/texhoru <<'WRAPPER'
#!/usr/bin/env bash
exec bash /opt/texhoru/deploy/cloud/manage.sh "$@"
WRAPPER
chmod 0755 /usr/local/bin/texhoru
docker compose --env-file /etc/texhoru/compose.env -f deploy/cloud/compose.yaml config --quiet
docker compose --env-file /etc/texhoru/compose.env -f deploy/cloud/compose.yaml build app
docker compose --env-file /etc/texhoru/compose.env -f deploy/cloud/compose.yaml up -d --wait --wait-timeout 180
echo 'Сервер запущен. HTTPS появится после настройки DNS и открытия портов 80/443.'
echo 'Проверка: sudo texhoru status. Данные входа: sudo texhoru credentials.'
echo 'Автоматические бэкапы и снимки не создаются. База 1С не изменялась.'
