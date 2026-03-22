#!/bin/sh
set -e

echo "──────────────────────────────────────────"
echo "  Healthcare API — Starting up"
echo "──────────────────────────────────────────"

echo "⏳  Running database migrations..."
npx sequelize-cli db:migrate --config .sequelizerc.js

echo "✅  Migrations complete"
echo "🚀  Starting server..."

exec node dist/server.js
