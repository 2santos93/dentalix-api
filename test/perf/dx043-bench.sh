#!/usr/bin/env bash
# DX-043 · benchmark de búsqueda de pacientes, listado, agenda y dashboard con
# RLS real. NO forma parte de la suite (ni jest ni CI): se corre a mano contra
# una base DESECHABLE.
#
# Uso:
#   test/perf/dx043-bench.sh <OWNER_URL> <APP_URL> [salida.md]
#     OWNER_URL  conexión del owner (superusuario) de una base desechable,
#                p. ej. postgresql://dentalix:dentalix@localhost:5432/dentalix_dx043_bench
#     APP_URL    la MISMA base con el rol de la app (sin BYPASSRLS),
#                p. ej. postgresql://dentalix_app:dentalix_app@localhost:5432/dentalix_dx043_bench
#     salida.md  fichero donde se reemplaza el bloque entre los marcadores
#                <!-- salida:inicio --> y <!-- salida:fin --> (por defecto
#                docs/perf/DX-043.md). Sin marcadores, imprime por stdout.
#
# Pasos: (1) aplica las migraciones (`prisma migrate deploy`, incluida la de
# DX-043), (2) siembra 60k pacientes y 350k citas en dos tenants
# (dx043-seed.sql; se niega si ya hay datos de bench), (3) «antes»: dentro de
# una transacción que se DESHACE, quita los índices de DX-043 y repone los que
# DX-043 retiró, y explica las consultas tal como las hacía main; (4) «después»:
# conectado como dentalix_app, explica las consultas nuevas; (5) el plan
# interno de la función SECURITY DEFINER (auto_explain anidado, sesión con
# SET ROLE dentalix_app).
# Todas las consultas se ejecutan con `app.current_tenant` fijado al tenant A
# (RLS real) y cada EXPLAIN (ANALYZE, BUFFERS) va precedido de una ejecución de
# calentamiento: los tiempos son con caché caliente.
set -euo pipefail

OWNER_URL="${1:?OWNER_URL requerido}"
APP_URL="${2:?APP_URL requerido}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
OUT="${3:-$ROOT/docs/perf/DX-043.md}"

TENANT_A='00000000-0000-4000-a000-00000000000a'
TENANT_B='00000000-0000-4000-a000-00000000000b'
SEDE_A1='00000000-0000-4000-b000-0000000000a1'
NOW="timestamp '2026-10-16 12:00'"
WEEK_FROM="timestamp '2026-10-19'"
WEEK_TO="timestamp '2026-10-26'"
PATIENT_COLS='"id", "tenantId", "firstName", "lastName", "docType", "docNumber", "birthDate", "sex", "phone", "email", "createdAt", "updatedAt"'

psql_owner() { psql -X -q -v ON_ERROR_STOP=1 "$OWNER_URL" "$@"; }
psql_app() { psql -X -q -v ON_ERROR_STOP=1 "$APP_URL" "$@"; }

# Bloque de EXPLAIN con calentamiento previo (salida descartada).
explain() {
  local title="$1" sql="$2"
  cat <<SQL
\\echo
\\echo '#### $title'
\\echo
\\o /dev/null
EXPLAIN (ANALYZE, BUFFERS) $sql;
\\o
\\echo '\`\`\`text'
EXPLAIN (ANALYZE, BUFFERS) $sql;
\\echo '\`\`\`'
SQL
}

# Valor escalar con su título (para comprobaciones de resultado).
check() {
  local title="$1" sql="$2"
  cat <<SQL
\\echo
\\echo '- $title:'
\\pset format unaligned
\\pset tuples_only on
$sql;
\\pset tuples_only off
\\pset format aligned
SQL
}

set_tenant() {
  echo "SELECT set_config('app.current_tenant', '$1', false) \\gset"
}

echo ">> migraciones" >&2
(cd "$ROOT" && DATABASE_URL="$APP_URL" DIRECT_URL="$OWNER_URL" npx prisma migrate deploy >&2)

if [ "$(psql_owner -Atc "SELECT count(*) FROM tenants WHERE subdomain IN ('bench-a','bench-b')")" != "0" ]; then
  echo ">> ya hay datos de bench: se reutilizan" >&2
else
  echo ">> siembra" >&2
  psql_owner -f "$HERE/dx043-seed.sql" >&2
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

SEARCH_BEFORE_WHERE="\"deletedAt\" IS NULL AND (\"firstName\" ILIKE '%arismendi%' OR \"lastName\" ILIKE '%arismendi%' OR \"docNumber\" ILIKE '%arismendi%')"

{
  echo "Generado por \`test/perf/dx043-bench.sh\` el $(date -u '+%Y-%m-%d %H:%M UTC') sobre $(psql_owner -Atc 'SHOW server_version') ."
  echo
  echo "Datos: $(psql_owner -Atc "SELECT count(*) FROM patients WHERE \"tenantId\" IN ('$TENANT_A','$TENANT_B')") pacientes y $(psql_owner -Atc "SELECT count(*) FROM appointments WHERE \"tenantId\" IN ('$TENANT_A','$TENANT_B')") citas en 2 tenants; el tenant A (el de las consultas) tiene $(psql_owner -Atc "SELECT count(*) FROM patients WHERE \"tenantId\" = '$TENANT_A'") pacientes y $(psql_owner -Atc "SELECT count(*) FROM appointments WHERE \"tenantId\" = '$TENANT_A'") citas."
  echo
  echo "### Antes (consultas de main, índices de main)"
  echo
  echo "Transacción deshecha al final: sin los índices de DX-043 y con los que DX-043 retiró. Rol efectivo \`dentalix_app\` (\`SET LOCAL ROLE\`), \`app.current_tenant\` = tenant A."
} >>"$TMP"

{
  cat <<SQL
BEGIN;
DROP INDEX patients_search_text_trgm_live_idx;
DROP INDEX patients_tenant_created_live_idx;
DROP INDEX appointments_tenant_location_start_idx;
DROP INDEX appointments_tenant_start_live_idx;
CREATE INDEX "patients_tenantId_idx" ON patients ("tenantId");
CREATE INDEX "locations_tenantId_idx" ON locations ("tenantId");
CREATE INDEX "appointments_tenantId_locationId_idx" ON appointments ("tenantId", "locationId");
ANALYZE patients;
ANALYZE appointments;
SET LOCAL ROLE dentalix_app;
SELECT set_config('app.current_tenant', '$TENANT_A', true) \\gset
SQL
  explain 'B1 · Búsqueda de un término raro ("arismendi"), página 1' \
    "SELECT $PATIENT_COLS FROM patients WHERE $SEARCH_BEFORE_WHERE ORDER BY \"createdAt\" DESC LIMIT 20 OFFSET 0"
  explain 'B1 · Conteo de la misma búsqueda' \
    "SELECT count(*) FROM patients WHERE $SEARCH_BEFORE_WHERE"
  check '"jose" (forma de main) encuentra' \
    "SELECT count(*) || ' pacientes (solo los escritos sin tilde)' FROM patients WHERE \"deletedAt\" IS NULL AND (\"firstName\" ILIKE '%jose%' OR \"lastName\" ILIKE '%jose%' OR \"docNumber\" ILIKE '%jose%')"
  explain 'B2 · Listado de pacientes, página 1' \
    "SELECT $PATIENT_COLS FROM patients WHERE \"deletedAt\" IS NULL ORDER BY \"createdAt\" DESC LIMIT 20 OFFSET 0"
  explain 'B2 · Listado de pacientes, página 2500 (offset 49980)' \
    "SELECT $PATIENT_COLS FROM patients WHERE \"deletedAt\" IS NULL ORDER BY \"createdAt\" DESC LIMIT 20 OFFSET 49980"
  explain 'B3 · Agenda de una sede, una semana' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $WEEK_FROM AND start < $WEEK_TO AND \"locationId\" = '$SEDE_A1' ORDER BY start ASC"
  explain 'B3 · Agenda consolidada (todas las sedes), una semana' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $WEEK_FROM AND start < $WEEK_TO ORDER BY start ASC"
  explain 'B4 · Dashboard: «próximas citas» (main lee 90 días y corta en memoria)' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $NOW AND start < $NOW + interval '90 days' ORDER BY start ASC"
  explain 'B5 · Dashboard: conteo de pacientes (main hace además la página 1 de B2)' \
    "SELECT count(*) FROM patients WHERE \"deletedAt\" IS NULL"
  echo 'ROLLBACK;'
} | psql_owner >>"$TMP"

{
  echo
  echo "### Después (consultas de esta rama)"
  echo
  echo "Conexión directa como \`dentalix_app\` (sin BYPASSRLS), \`app.current_tenant\` = tenant A."
} >>"$TMP"

{
  set_tenant "$TENANT_A"
  explain 'A1 · Búsqueda de un término raro ("arismendi"): ids de la página' \
    "SELECT id FROM dx_patient_search_ids('arismendi', 20, 0)"
  explain 'A1 · Conteo de la misma búsqueda' \
    "SELECT dx_patient_search_count('arismendi')"
  explain 'A1 · Filas completas de la página (bajo RLS, por id)' \
    "SELECT $PATIENT_COLS FROM patients WHERE id IN (SELECT id FROM dx_patient_search_ids('arismendi', 20, 0)) AND \"deletedAt\" IS NULL"
  explain 'A1 · Búsqueda por documento parcial ("770001234")' \
    "SELECT id FROM dx_patient_search_ids('770001234', 20, 0)"
  explain 'A1 · Término corto ("ma", 2 caracteres), tenant grande' \
    "SELECT id FROM dx_patient_search_ids('ma', 20, 0)"
  explain 'A1 · Conteo de "ma", tenant grande' \
    "SELECT dx_patient_search_count('ma')"
  explain 'A1 · Término común ("maria"), tenant grande' \
    "SELECT id FROM dx_patient_search_ids('maria', 20, 0)"
  explain 'A1 · Conteo de "maria", tenant grande' \
    "SELECT dx_patient_search_count('maria')"
  explain 'A1 · Término de 1 carácter ("a"): camino normal bajo RLS (Prisma), página' \
    "SELECT $PATIENT_COLS FROM patients WHERE \"deletedAt\" IS NULL AND (\"firstName\" ILIKE '%a%' OR \"lastName\" ILIKE '%a%' OR \"docNumber\" ILIKE '%a%') ORDER BY \"createdAt\" DESC, id DESC LIMIT 20 OFFSET 0"
  check '"jose" encuentra' \
    "SELECT dx_patient_search_count('jose') || ' pacientes (José y Jose)'"
  check 'de ellos, con tilde ("José")' \
    "SELECT count(*) FROM patients WHERE id IN (SELECT id FROM dx_patient_search_ids('jose', 100000, 0)) AND \"firstName\" = 'José'"
  check '"arismendi" en el tenant A devuelve pacientes del tenant B' \
    "SELECT count(*) FROM dx_patient_search_ids('arismendi', 100, 0) s JOIN patients p USING (id) WHERE p.\"tenantId\" <> '$TENANT_A'"
  explain 'A2 · Listado de pacientes, página 1' \
    "SELECT $PATIENT_COLS FROM patients WHERE \"deletedAt\" IS NULL ORDER BY \"createdAt\" DESC, id DESC LIMIT 20 OFFSET 0"
  explain 'A2 · Listado de pacientes, página 2500 (offset 49980)' \
    "SELECT $PATIENT_COLS FROM patients WHERE \"deletedAt\" IS NULL ORDER BY \"createdAt\" DESC, id DESC LIMIT 20 OFFSET 49980"
  explain 'A3 · Agenda de una sede, una semana' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $WEEK_FROM AND start < $WEEK_TO AND \"locationId\" = '$SEDE_A1' ORDER BY start ASC"
  explain 'A3 · Agenda consolidada (todas las sedes), una semana' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $WEEK_FROM AND start < $WEEK_TO ORDER BY start ASC"
  explain 'A4 · Dashboard: «próximas citas», consolidado (take 5)' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $NOW AND start < $NOW + interval '90 days' ORDER BY start ASC, id ASC LIMIT 5"
  explain 'A4 · Dashboard: «próximas citas», con sede (take 5)' \
    "SELECT * FROM appointments WHERE \"deletedAt\" IS NULL AND start >= $NOW AND start < $NOW + interval '90 days' AND \"locationId\" = '$SEDE_A1' ORDER BY start ASC, id ASC LIMIT 5"
  explain 'A5 · Dashboard: conteo de pacientes (ya sin la página de B2)' \
    "SELECT count(*) FROM patients WHERE \"deletedAt\" IS NULL"
  set_tenant "$TENANT_B"
  explain 'A1 · Término común ("maria"), tenant pequeño (B, 10k)' \
    "SELECT id FROM dx_patient_search_ids('maria', 20, 0)"
  explain 'A1 · Conteo de "maria", tenant pequeño (B, 10k)' \
    "SELECT dx_patient_search_count('maria')"
  check 'aislamiento: "arismendi" en el tenant B encuentra' \
    "SELECT dx_patient_search_count('arismendi') || ' paciente(s), todos del tenant B: ' || bool_and(p.\"tenantId\" = '$TENANT_B') FROM dx_patient_search_ids('arismendi', 100, 0) s JOIN patients p USING (id)"
} | psql_app >>"$TMP"

{
  echo
  echo "### Plan interno de la función SECURITY DEFINER"
  echo
  echo "\`auto_explain\` con \`log_nested_statements\` (lo carga el owner; después \`SET ROLE dentalix_app\` y \`app.current_tenant\` = tenant A). Dentro de la función la consulta corre como \`dentalix_patient_search\` (sin BYPASSRLS; su política \`USING (true)\` no añade security qual) con el filtro de tenant explícito: por eso puede usar el índice trigram."
  echo
  echo '```text'
} >>"$TMP"
{
  cat <<SQL
LOAD 'auto_explain';
SET auto_explain.log_min_duration = 0;
SET auto_explain.log_analyze = on;
SET auto_explain.log_buffers = on;
SET auto_explain.log_nested_statements = on;
SET auto_explain.log_level = notice;
SET client_min_messages = notice;
SET ROLE dentalix_app;
SELECT set_config('app.current_tenant', '$TENANT_A', false) \\gset
\\o /dev/null
SELECT id FROM dx_patient_search_ids('arismendi', 20, 0);
SELECT dx_patient_search_count('arismendi');
SQL
} | psql_owner 2>&1 >/dev/null | sed -e 's/^NOTICE:  //' | grep -v '^duration: .* plan:$' \
  | awk '
      # Un bloque por sentencia ("Query Text: ..."). Se omiten los que no
      # aportan: el set_config y el cuerpo de dx_search_normalize.
      function flush() { if (block != "" && block !~ /set_config|btrim/) printf "%s", block; block = "" }
      /^Query Text:/ { flush() }
      { block = block $0 "\n" }
      END { flush() }
    ' >>"$TMP" || true
echo '```' >>"$TMP"

if [ -f "$OUT" ] && grep -q '<!-- salida:inicio -->' "$OUT"; then
  awk -v tmp="$TMP" '
    /<!-- salida:inicio -->/ { print; while ((getline line < tmp) > 0) print line; skip = 1; next }
    /<!-- salida:fin -->/ { skip = 0 }
    !skip { print }
  ' "$OUT" >"$OUT.new" && mv "$OUT.new" "$OUT"
  echo ">> resultados escritos en $OUT" >&2
else
  cat "$TMP"
fi
