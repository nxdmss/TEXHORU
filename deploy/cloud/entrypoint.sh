#!/bin/sh
set -eu
node /app/deploy/cloud/init.mjs
exec node /app/server/dist/main.js
