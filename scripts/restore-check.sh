#!/usr/bin/env bash
# DX-082 · Comprobación de restauración de una copia de scripts/backup-db.sh.
#
#   RESTORE_ADMIN_URL=postgresql://postgres@localhost:5432/postgres \
#   BACKUP_AGE_IDENTITY_FILE=/ruta/segura/backup-key.txt \
#     scripts/restore-check.sh --file dentalix-prod_20261031T030000Z.dump.age \
#       [--report informe.json] [--tenant <uuid> [--tenant-out DIR]] \
#       [--keep [--db-name dx_restore_algo]] [--no-node] [--create-missing-roles]
#
# Pasos (cada uno cuenta en el informe; si uno falla, sale con 1):
#   sha256           el .sha256 hermano cuadra (antes de descifrar nada);
#   decrypt_restore  `age -d | pg_restore --exit-on-error` en una BD temporal
#                    NUEVA (<RESTORE_DB_PREFIX><timestamp>_<pid>, dueña el owner
#                    del manifiesto) y los ajustes de BD del manifiesto
#                    (TimeZone=UTC…). El volcado en claro no se escribe en disco;
#   migrate_status   `prisma migrate status` contra la BD restaurada;
#   force_rls        ninguna tabla de public con RLS sin FORCE (SQL propio);
#   check_force      `prisma/check-force.ts` (db:check-force, DX-134) contra ella;
#   counts           filas por tabla == manifiesto (misma instantánea que el
#                    volcado), sin tablas de más ni de menos;
#   tenant           con --tenant: extrae UNA clínica (ver abajo).
# Al final borra la BD temporal (salvo --keep) y escribe el informe JSON
# (tiempos, tamaños, conteos; nunca datos de filas) en --report y por stdout.
#
# --tenant <uuid>: de la BD restaurada, a CSV (columnas no generadas):
#   cada tabla de public con "tenantId"/tenant_id = <uuid>, `tenants` (id) y
#   los `users` con membresía en esa clínica. Lo vuelve a cargar en una copia
#   vacía de esas tablas (session_replication_role=replica) y comprueba que
#   cuadran las filas por tabla; luego lo empaqueta (tar) cifrado con la clave
#   PÚBLICA (BACKUP_AGE_RECIPIENTS_FILE o BACKUP_AGE_RECIPIENT) en --tenant-out
#   (por defecto, el directorio de --file) y borra los CSV en claro. Las tablas
#   globales (ciudades, monedas, tokens…) se listan como no extraídas.
#   Reimportar en producción: runbook docs/operacion/backups.md.
#
# Entorno:
#   RESTORE_ADMIN_URL         superusuario de un Postgres 16 DESECHABLE (local,
#                             CI o una instancia de restauración), o PG*.
#                             Superusuario porque restaura tablas con FORCE RLS
#                             conservando dueños y privilegios.
#   BACKUP_AGE_IDENTITY_FILE  clave PRIVADA de age (o --identity), o su
#                             contenido en BACKUP_AGE_IDENTITY (se escribe en un
#                             temporal 0600 y se borra). Nunca en el repo.
#   RESTORE_DB_PREFIX         prefijo de las BD temporales (dx_restore_). Solo
#                             se crean (y borran) bases con este prefijo.
# --no-node se salta migrate_status y check_force (sin Node ni el repo); el
# informe los marca `skipped`. Los roles del manifiesto (owner, dentalix_app,
# roles NOLOGIN) tienen que existir en el clúster; --create-missing-roles los
# crea NOLOGIN (solo en un clúster desechable).
# Salida: 0 todo bien; 1 una comprobación falló; 2 uso o configuración.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
# shellcheck source=lib/dx082-common.sh
. "$here/lib/dx082-common.sh"

usage() {
  sed -n '2,48p' "$0" | sed 's/^# \{0,1\}//'
}

file=''
manifest_file=''
identity="${BACKUP_AGE_IDENTITY_FILE:-}"
tenant=''
tenant_out=''
report_file=''
db_name=''
keep=0
no_node=0
create_roles=0
while (($# > 0)); do
  case "$1" in
    --file) file="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --manifest) manifest_file="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --identity) identity="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --tenant) tenant="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --tenant-out) tenant_out="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --report) report_file="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --db-name) db_name="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --keep) keep=1; shift ;;
    --no-node) no_node=1; shift ;;
    --create-missing-roles) create_roles=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$file" ]] || { usage >&2; exit 2; }
if [[ -n "$tenant" ]] && ! [[ "$tenant" =~ ^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$ ]]; then
  dx_die '--tenant debe ser el uuid de la clínica (tenants.id)' 2
fi
db_prefix="${RESTORE_DB_PREFIX:-dx_restore_}"
[[ "$db_prefix" =~ ^[a-z_][a-z0-9_]{0,30}$ ]] || dx_die 'RESTORE_DB_PREFIX: minúsculas, dígitos y «_», hasta 31' 2
if [[ -n "$db_name" ]]; then
  [[ "$db_name" =~ ^[a-z_][a-z0-9_]{0,58}$ && "$db_name" == "$db_prefix"* ]] ||
    dx_die "--db-name tiene que empezar por «$db_prefix» (minúsculas, dígitos y «_»)" 2
fi
[[ -f "$file" ]] || dx_die 'no existe --file' 2
manifest_file="${manifest_file:-${file%.dump.age}.manifest.json}"
file_name="$(basename -- "$file")"

umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/dx082-restore.XXXXXX")"

declare -A checks=()
order=(sha256 decrypt_restore migrate_status force_rls check_force counts)
[[ -n "$tenant" ]] && order+=(tenant)
for c in "${order[@]}"; do checks[$c]='not_run'; done
declare -A ms=()
started="$(dx_now_ms)"
tmpdb=''
created=0
verify_db=''
dropped=false
encrypted_bytes="$(wc -c <"$file" | tr -d ' ')"
restored_bytes=0
counts_json='{"tables": 0, "rows": 0, "mismatches": []}'
tenant_json='null'
source_json='null'
admin_db=''

pq() {
  local db="$1"
  shift
  psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse -d "$db" "$@" 2>>"$work/psql.err"
}

drop_db() {
  [[ -n "$1" && "$1" == "$db_prefix"* ]] || return 0
  pq "$admin_db" -v db="$1" <<'SQL' >/dev/null
SELECT format('DROP DATABASE IF EXISTS %I WITH (FORCE)', :'db') \gexec
SQL
}

finalize() {
  local rc=$? c sep='' checks_json='{' event
  set +e
  if [[ -n "$verify_db" ]]; then drop_db "$verify_db"; fi
  if ((created == 1 && keep == 0)); then
    drop_db "$tmpdb" && dropped=true
  fi
  for c in "${order[@]}"; do
    checks_json+="$sep\"$c\": \"${checks[$c]}\""
    sep=', '
  done
  checks_json+='}'
  event='restore_check.ok'
  ((rc == 0)) || event='restore_check.failed'
  ms[total]=$(($(dx_now_ms) - started))
  local timings='{' k sep2=''
  for k in sha256 restore migrate_status check_force counts tenant total; do
    [[ -n "${ms[$k]-}" ]] || continue
    timings+="$sep2\"$k\": ${ms[$k]}"
    sep2=', '
  done
  timings+='}'
  local report
  report="{\"event\": \"$event\", \"file\": $(dx_json_str "$file_name"), \"encrypted_bytes\": $encrypted_bytes, \"restored_db_bytes\": $restored_bytes, \"database\": $(dx_json_str "$tmpdb"), \"kept\": $( ((keep == 1)) && echo true || echo false), \"dropped\": $dropped, \"source\": $source_json, \"checks\": $checks_json, \"timings_ms\": $timings, \"counts\": $counts_json, \"tenant\": $tenant_json}"
  if [[ -n "$report_file" ]]; then printf '%s\n' "$report" >"$report_file"; fi
  printf '%s\n' "$report"
  dx_log "restore-check: ${event#restore_check.} en ${ms[total]} ms ($encrypted_bytes bytes cifrados, BD restaurada $restored_bytes bytes)"
  rm -rf "$work"
  exit "$rc"
}
trap finalize EXIT

fail() {
  checks[$1]='failed'
  dx_log "ERROR: $2"
  dx_pg_errors "$work/psql.err" >&2
  exit 1
}

# 1. SHA-256, antes de descifrar nada.
t0="$(dx_now_ms)"
sidecar="$file.sha256"
[[ -f "$sidecar" ]] || fail sha256 "falta $file_name.sha256 junto a la copia"
expected_sha="$(cut -d' ' -f1 "$sidecar")"
actual_sha="$(sha256sum -- "$file" | cut -d' ' -f1)"
[[ "$expected_sha" == "$actual_sha" ]] || fail sha256 'el SHA-256 de la copia no coincide con su .sha256 (copia corrupta o alterada)'
checks[sha256]='ok'
ms[sha256]=$(($(dx_now_ms) - t0))

tools=(psql pg_restore age)
[[ -z "$tenant" ]] || tools+=(tar)
dx_require_tools "${tools[@]}"

[[ -f "$manifest_file" ]] || dx_die "falta el manifiesto $(basename -- "$manifest_file")" 2
manifest="$(head -c 4000000 "$manifest_file")"
[[ "$manifest" == *'"dx082-manifest/1"'* ]] || dx_die 'el manifiesto no es de backup-db.sh (dx082-manifest/1)' 2

if [[ -z "$identity" && -n "${BACKUP_AGE_IDENTITY:-}" ]]; then
  identity="$work/identity"
  printf '%s\n' "$BACKUP_AGE_IDENTITY" >"$identity"
fi
unset BACKUP_AGE_IDENTITY
[[ -n "$identity" && -r "$identity" ]] || dx_die 'falta la clave privada: BACKUP_AGE_IDENTITY_FILE, --identity o BACKUP_AGE_IDENTITY' 2

recipients_args=()
if [[ -n "$tenant" ]]; then
  if [[ -n "${BACKUP_AGE_RECIPIENTS_FILE:-}" ]]; then
    recipients_args=(-R "$BACKUP_AGE_RECIPIENTS_FILE")
  elif [[ -n "${BACKUP_AGE_RECIPIENT:-}" ]]; then
    recipients_args=(-r "$BACKUP_AGE_RECIPIENT")
  else
    dx_die '--tenant cifra lo extraído: falta BACKUP_AGE_RECIPIENTS_FILE o BACKUP_AGE_RECIPIENT (clave pública)' 2
  fi
  tenant_out="${tenant_out:-$(dirname -- "$file")}"
  mkdir -p "$tenant_out"
fi

if [[ -n "${RESTORE_ADMIN_URL:-}" ]]; then
  dx_export_pg_url "$RESTORE_ADMIN_URL"
elif [[ -z "${PGHOST:-}${PGUSER:-}${PGDATABASE:-}" ]]; then
  dx_die 'falta la conexión: RESTORE_ADMIN_URL (superusuario de un Postgres desechable) o PGHOST/PGUSER' 2
fi
unset RESTORE_ADMIN_URL DIRECT_URL DATABASE_URL
admin_db="${PGDATABASE:-postgres}"
unset PGDATABASE

# 2. Superusuario, roles del manifiesto y BD temporal nueva.
is_super="$(pq "$admin_db" <<<'SELECT rolsuper FROM pg_roles WHERE rolname = current_user;')" ||
  fail decrypt_restore 'no se pudo conectar como admin (la URL no se muestra)'
[[ "$is_super" == 't' ]] || fail decrypt_restore 'RESTORE_ADMIN_URL tiene que ser superusuario de un Postgres desechable'

meta="$(pq "$admin_db" -v manifest="$manifest" <<'SQL'
SELECT m->>'owner', m->>'database', m->>'created_at', coalesce(m->>'last_migration', ''),
       (SELECT coalesce(string_agg(r, ' ' ORDER BY r), '')
          FROM json_array_elements_text(coalesce(m->'roles', '[]'::json)) r
         WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r))
  FROM (SELECT (:'manifest')::json AS m) x;
SQL
)" || fail decrypt_restore 'el manifiesto no es JSON válido'
IFS='|' read -r owner src_db src_created src_migration missing_roles <<<"$meta"
source_json="{\"database\": $(dx_json_str "$src_db"), \"created_at\": $(dx_json_str "$src_created"), \"last_migration\": $(dx_json_str "$src_migration"), \"owner\": $(dx_json_str "$owner")}"
if [[ -n "$missing_roles" ]]; then
  if ((create_roles == 0)); then
    fail decrypt_restore "faltan roles en el clúster: $missing_roles (créalos o usa --create-missing-roles en un clúster desechable)"
  fi
  pq "$admin_db" -v manifest="$manifest" <<'SQL' >/dev/null || fail decrypt_restore 'no se pudieron crear los roles'
SELECT format('CREATE ROLE %I NOLOGIN', r)
  FROM json_array_elements_text((:'manifest')::json->'roles') r
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) \gexec
SQL
  dx_log "Roles creados NOLOGIN: $missing_roles"
fi

tmpdb="${db_name:-${db_prefix}$(date -u +%Y%m%d%H%M%S)_$$}"
exists="$(pq "$admin_db" -v db="$tmpdb" <<<"SELECT count(*) FROM pg_database WHERE datname = :'db';")" ||
  fail decrypt_restore 'no se pudo consultar pg_database'
[[ "$exists" == 0 ]] || { tmpdb=''; fail decrypt_restore '--db-name ya existe: restore-check solo restaura en una BD nueva'; }
pq "$admin_db" -v db="$tmpdb" -v owner="$owner" <<'SQL' >/dev/null || fail decrypt_restore 'no se pudo crear la BD temporal'
SELECT format('CREATE DATABASE %I OWNER %I TEMPLATE template0', :'db', :'owner') \gexec
SQL
created=1
dx_log "BD temporal: $tmpdb (owner $owner)"

# 3. Descifrar y restaurar en streaming (el volcado en claro no toca el disco).
t0="$(dx_now_ms)"
if ! age -d -i "$identity" -- "$file" 2>"$work/age.err" |
  pg_restore --exit-on-error --no-password -d "$tmpdb" 2>"$work/restore.err"; then
  dx_pg_errors "$work/age.err" >&2
  dx_pg_errors "$work/restore.err" >&2
  fail decrypt_restore 'falló el descifrado o pg_restore (¿otra clave privada, copia alterada o roles distintos?)'
fi
pq "$admin_db" -v db="$tmpdb" -v manifest="$manifest" <<'SQL' >/dev/null || fail decrypt_restore 'no se pudieron aplicar los ajustes de la BD'
SELECT format('ALTER DATABASE %I SET %I = %L', :'db', key, value)
  FROM json_each_text(coalesce((:'manifest')::json->'database_settings', '{}'::json)) \gexec
SQL
ms[restore]=$(($(dx_now_ms) - t0))
checks[decrypt_restore]='ok'
restored_bytes="$(pq "$admin_db" -v db="$tmpdb" <<<"SELECT pg_database_size(:'db');")"
dx_log "Restaurada en ${ms[restore]} ms"

# 4. FORCE RLS en todas las tablas con RLS (sin Node).
force="$(pq "$tmpdb" <<'SQL'
SELECT count(*) FILTER (WHERE c.relforcerowsecurity) || '|' ||
       coalesce(string_agg(c.relname, ' ' ORDER BY c.relname) FILTER (WHERE NOT c.relforcerowsecurity), '')
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relrowsecurity;
SQL
)" || fail force_rls 'no se pudo leer pg_class'
IFS='|' read -r forced unforced <<<"$force"
if [[ "$forced" -gt 0 && -z "$unforced" ]]; then
  checks[force_rls]='ok'
else
  checks[force_rls]='failed'
  dx_log "ERROR: tablas con RLS sin FORCE: ${unforced:-ninguna con RLS}"
fi

# 5. prisma migrate status y db:check-force contra la BD restaurada.
if ((no_node == 1)); then
  checks[migrate_status]='skipped'
  checks[check_force]='skipped'
else
  dx_require_tools npx
  purl="$(dx_prisma_url "$tmpdb")"
  t0="$(dx_now_ms)"
  if (cd "$repo" && DATABASE_URL="$purl" DIRECT_URL="$purl" npx --no-install prisma migrate status --schema prisma/schema.prisma) >"$work/migrate.out" 2>&1; then
    checks[migrate_status]='ok'
  else
    checks[migrate_status]='failed'
    grep -vE '^(Environment|Prisma schema|Datasource|warn|For more)' "$work/migrate.out" | cut -c1-200 | head -n 30 >&2 || true
  fi
  ms[migrate_status]=$(($(dx_now_ms) - t0))
  t0="$(dx_now_ms)"
  if (cd "$repo" && DATABASE_URL="$purl" DIRECT_URL="$purl" npx --no-install ts-node --transpile-only prisma/check-force.ts) >"$work/check-force.out" 2>&1; then
    checks[check_force]='ok'
  else
    checks[check_force]='failed'
    grep -E 'check_force' "$work/check-force.out" | cut -c1-2000 >&2 || true
  fi
  ms[check_force]=$(($(dx_now_ms) - t0))
  unset purl
fi

# 6. Filas por tabla contra el manifiesto.
t0="$(dx_now_ms)"
current="$(printf '%s;\n' "$DX_COUNTS_SQL" | pq "$tmpdb")" || fail counts 'no se pudo contar en la BD restaurada'
cmp="$(pq "$tmpdb" -v exp="$manifest" -v cur="$current" <<'SQL'
WITH e AS (SELECT key, value::bigint AS v FROM json_each_text((:'exp')::json->'tables')),
     c AS (SELECT key, value::bigint AS v FROM json_each_text((:'cur')::json->'tables')),
     d AS (SELECT coalesce(e.key, c.key) AS t, e.v AS expected, c.v AS found
             FROM e FULL JOIN c ON c.key = e.key
            WHERE e.v IS DISTINCT FROM c.v)
SELECT (SELECT count(*) FROM d) || '|' ||
       json_build_object('tables', (SELECT count(*) FROM c), 'rows', (SELECT coalesce(sum(v), 0) FROM c),
         'mismatches', (SELECT coalesce(json_agg(json_build_object('table', t, 'expected', expected, 'found', found) ORDER BY t), '[]'::json) FROM d));
SQL
)" || fail counts 'no se pudo comparar con el manifiesto'
n_mismatch="${cmp%%|*}"
counts_json="${cmp#*|}"
ms[counts]=$(($(dx_now_ms) - t0))
if [[ "$n_mismatch" == 0 ]]; then
  checks[counts]='ok'
else
  checks[counts]='failed'
  dx_log "ERROR: $n_mismatch tablas no cuadran con el manifiesto (ver counts.mismatches)"
fi

# 7. Una sola clínica.
if [[ -n "$tenant" ]]; then
  t0="$(dx_now_ms)"
  tdir_name="tenant-${tenant}"
  tdir="$work/$tdir_name"
  mkdir -m 700 "$tdir"
  # Tablas de la clínica, su condición y sus columnas no generadas.
  SEL="
WITH sel AS (
  (SELECT DISTINCT ON (c.relname) c.relname AS rel, format('%I = %L::uuid', a.attname, :'tenant') AS cond
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
                        AND a.attname IN ('tenantId', 'tenant_id')
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname, a.attname)
  UNION ALL SELECT 'tenants', format('id = %L::uuid', :'tenant')
  UNION ALL SELECT 'users', format('id IN (SELECT \"userId\" FROM public.clinic_memberships WHERE \"tenantId\" = %L::uuid)', :'tenant')
), cols AS (
  SELECT s.rel, s.cond, (SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY a.attnum)
                           FROM pg_attribute a
                          WHERE a.attrelid = format('public.%I', s.rel)::regclass
                            AND a.attnum > 0 AND NOT a.attisdropped AND a.attgenerated = '') AS cols
    FROM sel s
)"
  found="$(pq "$tmpdb" -v tenant="$tenant" <<<"SELECT count(*) FROM public.tenants WHERE id = :'tenant'::uuid;")" ||
    fail tenant 'no se pudo buscar la clínica'
  [[ "$found" == 1 ]] || fail tenant 'la clínica no está en esta copia'

  counts_sql="$SEL
, n AS (SELECT rel, (xpath('/row/c/text()', query_to_xml(format('SELECT count(*) AS c FROM public.%I WHERE %s', rel, CASE WHEN :'all' = '1' THEN 'true' ELSE cond END), false, true, '')))[1]::text::bigint AS n FROM cols)
SELECT json_object_agg(rel, n ORDER BY rel) || '|' ||
       coalesce(json_object_agg(rel, n ORDER BY rel) FILTER (WHERE n > 0), '{}'::json) || '|' || sum(n) || '|' ||
       (SELECT coalesce(json_agg(c.relname ORDER BY c.relname), '[]'::json)
          FROM pg_class c JOIN pg_namespace ns ON ns.oid = c.relnamespace
         WHERE ns.nspname = 'public' AND c.relkind = 'r' AND c.relname NOT IN (SELECT rel FROM cols))
  FROM n;"
  tcounts="$(pq "$tmpdb" -v tenant="$tenant" -v all=0 <<<"$counts_sql")" || fail tenant 'no se pudo contar las filas de la clínica'
  IFS='|' read -r t_all t_nonzero t_rows t_global <<<"$tcounts"

  pq "$tmpdb" -v tenant="$tenant" -v dir="$tdir" <<<"$SEL
SELECT format('\\copy (SELECT %s FROM public.%I WHERE %s) TO %L WITH (FORMAT csv, HEADER)', cols, rel, cond, :'dir' || '/' || rel || '.csv') FROM cols ORDER BY rel;" >"$work/tenant-out.psql" ||
    fail tenant 'no se pudo preparar la extracción'
  pq "$tmpdb" -f "$work/tenant-out.psql" >/dev/null || fail tenant 'falló la extracción a CSV'

  # Verificación: copia de la BD restaurada, vacía en esas tablas, y recarga.
  verify_db="${tmpdb}_t"
  pq "$admin_db" -v db="$verify_db" -v tpl="$tmpdb" <<'SQL' >/dev/null || fail tenant 'no se pudo crear la BD de verificación'
SELECT format('CREATE DATABASE %I TEMPLATE %I', :'db', :'tpl') \gexec
SQL
  {
    printf 'SET session_replication_role = replica;\n'
    pq "$verify_db" -v tenant="$tenant" -v dir="$tdir" <<<"$SEL
SELECT 'TRUNCATE ' || string_agg(format('public.%I', rel), ', ') || ' CASCADE;' FROM cols;
$SEL
SELECT format('\\copy public.%I (%s) FROM %L WITH (FORMAT csv, HEADER)', rel, cols, :'dir' || '/' || rel || '.csv') FROM cols ORDER BY rel;"
  } >"$work/tenant-in.psql" || fail tenant 'no se pudo preparar la recarga'
  pq "$verify_db" -f "$work/tenant-in.psql" >/dev/null || fail tenant 'falló la recarga de los CSV'
  vcounts="$(pq "$verify_db" -v tenant="$tenant" -v all=1 <<<"$counts_sql")" || fail tenant 'no se pudo contar en la BD de verificación'
  v_all="${vcounts%%|*}"
  drop_db "$verify_db" || true
  verify_db=''
  verified=false
  [[ "$v_all" == "$t_all" ]] && verified=true

  printf '%s\n' "{\"tenant\": \"$tenant\", \"source\": $source_json, \"tables\": $t_all}" >"$tdir/counts.json"
  archive="dentalix-tenant-${tenant}_$(date -u +%Y%m%dT%H%M%SZ).tar.age"
  if ! tar -C "$work" -cf - "$tdir_name" | age "${recipients_args[@]}" -o "$tenant_out/$archive" 2>"$work/age-out.err"; then
    rm -f "$tenant_out/$archive"
    dx_pg_errors "$work/age-out.err" >&2
    fail tenant 'no se pudo cifrar lo extraído'
  fi
  rm -rf "$tdir"
  ms[tenant]=$(($(dx_now_ms) - t0))
  tenant_json="{\"id\": \"$tenant\", \"rows\": ${t_rows:-0}, \"tables\": $t_nonzero, \"verified\": $verified, \"archive\": $(dx_json_str "$archive"), \"not_extracted\": $t_global}"
  if [[ "$verified" == true ]]; then
    checks[tenant]='ok'
    dx_log "Clínica $tenant: ${t_rows:-0} filas extraídas y verificadas → $archive"
  else
    checks[tenant]='failed'
    dx_log 'ERROR: la recarga de la clínica no cuadra con lo extraído'
  fi
fi

for c in "${order[@]}"; do
  if [[ "${checks[$c]}" == 'failed' ]]; then exit 1; fi
done
exit 0
