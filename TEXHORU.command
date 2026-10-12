#!/bin/bash
cd "$(dirname "$0")"
printf '\033]0;TEXHORU DEV\007'
npm run dev
printf '\nTEXHORU остановлен. Нажми Enter, чтобы закрыть окно.\n'
read -r
