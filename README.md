# TEXHORU

Интернет-магазин электроники TEXHORU: React + Vite, NestJS, Prisma/SQLite для локальной разработки и интеграция с 1С.

## Быстрый запуск на MacBook

Нужен **Node.js 22**.

После `git clone` можно просто дважды открыть **`TEXHORU.command`**. На первом запуске он сам:

- установит зависимости frontend/backend;
- создаст `server/.env.local` из безопасного dev-шаблона;
- сгенерирует Prisma Client;
- подготовит SQLite;
- создаст локального администратора;
- запустит API и Vite;
- откроет `http://127.0.0.1:5173/` в браузере.

Остановка: **`TEXHORU STOP.command`** или `Ctrl+C` в терминале.

Если macOS блокирует файл после скачивания ZIP, запускай проект из клонированного Git-репозитория: Git сохраняет executable-bit `.command` файлов.

## Терминал (macOS / Linux / Windows)

```bash
npm run setup
npm run dev
```

Адреса:

- магазин: `http://127.0.0.1:5173/`
- админка: `http://127.0.0.1:5173/admin`
- API health: `http://127.0.0.1:3000/api/health`

Dev admin по умолчанию:

- `director@texhoru.local`
- `ChangeMe123!`

Только для локальной разработки. Production-секреты в Git не коммитятся.

## Windows

Локальные `TEXHORU.exe` / `TEXHORU STOP.exe` можно продолжать использовать, но в Git они намеренно игнорируются. Кроссплатформенный вариант: `TEXHORU-WINDOWS.cmd`.

## Данные

В Git **не попадают**:

- SQLite `server/prisma/dev-local.db`;
- `.env.local`;
- `server/uploads/`;
- `node_modules`;
- логи и локальные launcher-файлы.

Для переноса реального каталога используй экспорт/импорт данных, а не коммит базы.

## 1С

Endpoint каталога:

`POST /api/integrations/1c/catalog`

Авторизация dev-интеграции: заголовок `x-1c-key`, значение задаётся через `ONE_C_API_KEY` в `server/.env.local`.

Пример тестового модуля 1С лежит в `onec/TEXHORU-Товары-ПриЗаписи.bsl`. Для production категории должны быть отдельным справочником 1С со своими GUID.

## Проверка перед push

```bash
npm run build:all
```

GitHub Actions дополнительно проверяет сборку на Ubuntu и macOS.
