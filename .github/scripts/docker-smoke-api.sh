#!/usr/bin/env bash
# DX-083: prueba de humo de la imagen de la API contra un Postgres DESECHABLE
# (CI: el servicio del job; en local, un contenedor nuevo). Todo con la
# imagen, sin node_modules del host:
#   1. El admin del clúster crea un owner SIN superusuario de nombre distinto
#      de `dentalix` y su base; el owner crea dentalix_app
#      (docker/prod/create-app-role.sql).
#   2. `prisma migrate deploy` como job con DIRECT_URL (el owner), el seed de
#      referencia (`seed:prod`) y `audit:purge:prod --dry-run`, sin devDeps.
#   3. La API arranca con NODE_ENV=production como dentalix_app (sin
#      SUPERUSER ni BYPASSRLS), sin root, y responde /api/v1/health y
#      /api/v1/health/ready. (Que dentalix_app no ve filas sin
#      app.current_tenant, con datos, lo comprueba el job owner-nosu.)
#   4. `docker stop` (SIGTERM): sale con código 0 tras el apagado ordenado.
# El clúster tiene que ser nuevo: crea roles de clúster (dentalix_app y los
# de las migraciones) con contraseñas aleatorias.
#   PG_ADMIN_URL=postgresql://postgres:postgres@localhost:5432/postgres \
#     .github/scripts/docker-smoke-api.sh dentalix-api:ci
set -euo pipefail

IMAGE="${1:?Uso: $0 <imagen>}"
ADMIN_URL="${PG_ADMIN_URL:?Falta PG_ADMIN_URL (superusuario del clúster desechable)}"
API_PORT="${SMOKE_API_PORT:-3300}"
DB=dentalix_smoke
OWNER=clinica_owner
OWNER_PW="$(openssl rand -hex 16)"
APP_PW="$(openssl rand -hex 16)"
NAME=dx-api-smoke

# host:puerto del clúster, de la URL del admin.
HOSTPORT="$(sed -E 's|^postgres(ql)?://[^@]*@([^/]+)/.*$|\2|' <<<"$ADMIN_URL")"
DIRECT_URL="postgresql://${OWNER}:${OWNER_PW}@${HOSTPORT}/${DB}?schema=public"
DATABASE_URL="postgresql://dentalix_app:${APP_PW}@${HOSTPORT}/${DB}?schema=public"

cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT
fail() { echo "FALLO: $*" >&2; docker logs "$NAME" >&2 2>/dev/null || true; exit 1; }

echo "==> Owner '$OWNER' sin SUPERUSER ni BYPASSRLS, y su base"
psql -v ON_ERROR_STOP=1 "$ADMIN_URL" -q <<SQL
CREATE ROLE ${OWNER} LOGIN PASSWORD '${OWNER_PW}'
  NOSUPERUSER NOBYPASSRLS CREATEROLE NOCREATEDB NOREPLICATION;
CREATE DATABASE ${DB} OWNER ${OWNER};
SQL

echo "==> dentalix_app, creado por el owner (create-app-role.sql)"
psql -v ON_ERROR_STOP=1 "${DIRECT_URL%%\?*}" -q -v app_password="$APP_PW" \
  -f "$(dirname "$0")/../../docker/prod/create-app-role.sql"

run() {
  docker run --rm --network host -e DATABASE_URL="$DATABASE_URL" \
    -e DIRECT_URL="$DIRECT_URL" "$IMAGE" "$@"
}
echo "==> migrate deploy (job con DIRECT_URL, desde la imagen)"
run npx prisma migrate deploy
echo "==> Seed de referencia y purga de auditoría (dry-run), sin devDependencies"
run npm run --silent seed:prod
run npm run --silent audit:purge:prod -- --dry-run
# Sin --actor-email: en el humo no hay administrador de plataforma (el dry-run no lo exige).
run npm run --silent retention:raise-floor:prod -- --dry-run

echo "==> API con NODE_ENV=production"
# Valores de humo, NO secretos: con ellos la API pasa la validación de
# producción. El bucket y el SMTP no se contactan al arrancar.
docker run -d --name "$NAME" --network host \
  -e PORT="$API_PORT" \
  -e DATABASE_URL="$DATABASE_URL" -e DIRECT_URL="$DIRECT_URL" \
  -e JWT_ACCESS_SECRET="$(openssl rand -hex 32)" \
  -e JWT_REFRESH_SECRET="$(openssl rand -hex 32)" \
  -e JWT_ACCESS_TTL=900s -e JWT_REFRESH_TTL=30d \
  -e CORS_ROOT_DOMAIN=dentalix.example -e TENANT_BASE_DOMAINS=dentalix.example \
  -e FILES_PUBLIC_BASE_URL=https://api.dentalix.example/api/v1/files \
  -e MAIL_TRANSPORT=smtp -e SMTP_URL=smtps://humo:humo@smtp.dentalix.example:465 \
  -e MAIL_FROM=no-reply@dentalix.example \
  -e MAIL_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -e MFA_ENCRYPTION_KEY="$(openssl rand -hex 32)" \
  -e STORAGE_DRIVER=s3 -e S3_BUCKET=dentalix-humo -e S3_REGION=us-east-1 \
  -e SHUTDOWN_DRAIN_MS=1000 -e LOG_LEVEL=info \
  "$IMAGE" >/dev/null

for _ in $(seq 1 60); do
  if curl -fs -o /dev/null "http://127.0.0.1:${API_PORT}/api/v1/health"; then break; fi
  docker ps -q --filter "name=^${NAME}$" | grep -q . || fail "la API terminó al arrancar"
  sleep 1
done
curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health" | grep -q '"ok"' || fail "/api/v1/health"
curl -fsS "http://127.0.0.1:${API_PORT}/api/v1/health/ready" | grep -q '"up"' || fail "/api/v1/health/ready"
[[ "$(docker exec "$NAME" id -u)" != 0 ]] || fail "la API corre como root"
echo "/api/v1/health y /health/ready: 200; usuario $(docker exec "$NAME" id -un)"

psql -v ON_ERROR_STOP=1 "${DATABASE_URL%%\?*}" -tAc \
  "SELECT rolsuper OR rolbypassrls FROM pg_roles WHERE rolname = current_user" | grep -qx f \
  || fail "dentalix_app es superusuario o BYPASSRLS"

echo "==> SIGTERM: apagado ordenado"
docker stop -t 30 "$NAME" >/dev/null
status="$(docker inspect -f '{{.State.ExitCode}}' "$NAME")"
docker logs "$NAME" 2>&1 | grep -q 'shutdown.done' || fail "no terminó el apagado ordenado"
[[ "$status" = 0 ]] || fail "salió con código $status"
echo "Humo de la imagen de la API: OK"
