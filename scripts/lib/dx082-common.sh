# shellcheck shell=bash
# DX-082 · Funciones comunes de scripts/backup-db.sh y scripts/restore-check.sh.
# Se carga con `.`; no se ejecuta sola. Nada de aquí imprime credenciales: la
# URL se descompone en variables PG* de libpq (no viajan en argv, que ve
# cualquier usuario con `ps`) y los errores de Postgres se filtran para no
# sacar valores de filas (DETAIL/CONTEXT de un COPY llevan datos).

dx_log() { printf '%s\n' "$*" >&2; }

# dx_die MENSAJE [CÓDIGO]
dx_die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit "${2:-1}"
}

dx_require_tools() {
  local t missing=()
  for t in "$@"; do
    command -v "$t" >/dev/null 2>&1 || missing+=("$t")
  done
  if ((${#missing[@]} > 0)); then
    dx_die "faltan herramientas en el PATH: ${missing[*]}"
  fi
}

# Milisegundos desde epoch (bash ≥ 5: EPOCHREALTIME).
dx_now_ms() {
  local t="${EPOCHREALTIME/[.,]/}"
  printf '%s' "$((t / 1000))"
}

dx_pct_decode() {
  # Primero las «\» literales (una contraseña sin codificar puede llevarlas):
  # si no, `%b` las tomaría por escapes (\n, \t, \0…) y cambiaría el valor.
  local s="${1//\\/\\\\}"
  s="${s//%/\\x}"
  printf '%b' "$s"
}

dx_pct_encode() {
  local LC_ALL=C s="$1" out='' c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *) printf -v c '%%%02X' "'$c" && out+="$c" ;;
    esac
  done
  printf '%s' "$out"
}

# Cadena JSON (comillas incluidas). Solo para nombres y mensajes propios.
dx_json_str() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//\"/\\\"}"
  s="${s//$'\n'/\\n}"
  s="${s//$'\t'/\\t}"
  printf '"%s"' "$s"
}

_dx_export() {
  printf -v "$1" '%s' "$2"
  export "${1?}"
}

# dx_export_pg_url URL: exporta PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE
# y PGSSLMODE (y afines) desde una URL postgresql:// (la de Prisma vale: el
# `?schema=` se ignora). Admite `?host=/ruta/al/socket`.
dx_export_pg_url() {
  local url="$1" rest auth='' hostport path='' query='' user='' pass='' host='' port='' kv k v
  [[ "$url" =~ ^postgres(ql)?:// ]] || dx_die 'la URL de la BD no empieza por postgresql:// (no se muestra)' 2
  rest="${url#*://}"
  if [[ "$rest" == *\?* ]]; then
    query="${rest#*\?}"
    rest="${rest%%\?*}"
  fi
  if [[ "$rest" == */* ]]; then
    path="${rest#*/}"
    rest="${rest%%/*}"
  fi
  if [[ "$rest" == *@* ]]; then
    auth="${rest%@*}"
    hostport="${rest##*@}"
  else
    hostport="$rest"
  fi
  if [[ "$auth" == *:* ]]; then
    user="${auth%%:*}"
    pass="${auth#*:}"
  else
    user="$auth"
  fi
  if [[ "$hostport" == \[* ]]; then
    host="${hostport%%]*}"
    host="${host#[}"
    [[ "$hostport" == *\]:* ]] && port="${hostport##*]:}"
  else
    host="${hostport%%:*}"
    [[ "$hostport" == *:* ]] && port="${hostport#*:}"
  fi

  unset PGHOST PGHOSTADDR PGPORT PGUSER PGPASSWORD PGDATABASE PGSSLMODE \
    PGSSLROOTCERT PGSSLCERT PGSSLKEY PGAPPNAME PGCONNECT_TIMEOUT PGSERVICE
  [[ -z "$host" ]] || _dx_export PGHOST "$(dx_pct_decode "$host")"
  [[ -z "$port" ]] || _dx_export PGPORT "$port"
  [[ -z "$user" ]] || _dx_export PGUSER "$(dx_pct_decode "$user")"
  [[ -z "$pass" ]] || _dx_export PGPASSWORD "$(dx_pct_decode "$pass")"
  [[ -z "$path" ]] || _dx_export PGDATABASE "$(dx_pct_decode "$path")"

  local IFS='&'
  for kv in $query; do
    k="${kv%%=*}"
    v="$(dx_pct_decode "${kv#*=}")"
    case "$k" in
      host) _dx_export PGHOST "$v" ;;
      port) _dx_export PGPORT "$v" ;;
      user) _dx_export PGUSER "$v" ;;
      dbname) _dx_export PGDATABASE "$v" ;;
      sslmode) _dx_export PGSSLMODE "$v" ;;
      sslrootcert) _dx_export PGSSLROOTCERT "$v" ;;
      sslcert) _dx_export PGSSLCERT "$v" ;;
      sslkey) _dx_export PGSSLKEY "$v" ;;
      application_name) _dx_export PGAPPNAME "$v" ;;
      connect_timeout) _dx_export PGCONNECT_TIMEOUT "$v" ;;
      # De Prisma, sin sentido para libpq.
      schema | connection_limit | pool_timeout | pgbouncer | statement_cache_size | socket_timeout) ;;
      '') ;;
      *) dx_log "aviso: parámetro «$k» de la URL ignorado" ;;
    esac
  done
}

# dx_prisma_url BASE: URL para Prisma hacia BASE con la conexión de las PG*
# actuales (la contraseña va codificada; la URL solo se pasa por entorno).
dx_prisma_url() {
  local db="$1" user="${PGUSER:-$(id -un)}" host="${PGHOST:-}" port="${PGPORT:-5432}" cred q=''
  cred="$(dx_pct_encode "$user")"
  [[ -n "${PGPASSWORD:-}" ]] && cred+=":$(dx_pct_encode "$PGPASSWORD")"
  if [[ -z "$host" || "$host" == /* ]]; then
    q="?host=$(dx_pct_encode "${host:-/var/run/postgresql}")"
    host='localhost'
  fi
  if [[ -n "${PGSSLMODE:-}" && -n "$q" ]]; then
    q+="&sslmode=${PGSSLMODE}"
  elif [[ -n "${PGSSLMODE:-}" ]]; then
    q="?sslmode=${PGSSLMODE}"
  fi
  printf 'postgresql://%s@%s:%s/%s%s' "$cred" "$host" "$port" "$(dx_pct_encode "$db")" "$q"
}

# dx_pg_errors FICHERO: las líneas de error de pg_dump/pg_restore/psql/age
# sin DETAIL ni CONTEXT (pueden llevar valores de filas), recortadas.
dx_pg_errors() {
  [[ -s "$1" ]] || return 0
  grep -E '^(pg_dump|pg_restore|psql|age|ERROR|FATAL|HINT|error)' "$1" |
    grep -vE '(DETAIL|CONTEXT):' | cut -c1-300 | head -n 20 || true
}

# Recuento exacto de filas de cada tabla (hojas: tablas y particiones) más los
# metadatos del manifiesto. Una sola línea JSON; la marca dx082_manifest la
# usan los tests con stubs. Se ejecuta en la transacción del snapshot que
# exporta backup-db.sh (mismos datos que el volcado) y, en restore-check, en
# la BD restaurada.
# shellcheck disable=SC2016,SC2034 # la usan los scripts que cargan esta librería
DX_COUNTS_SQL='
WITH /* dx082_manifest */ t AS (
  SELECT n.nspname || $$.$$ || c.relname AS name,
         (xpath($$/row/c/text()$$, query_to_xml(format($$SELECT count(*) AS c FROM %I.%I$$, n.nspname, c.relname), false, true, $$$$)))[1]::text::bigint AS n
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind = $$r$$ AND n.nspname NOT IN ($$pg_catalog$$, $$information_schema$$)
     AND n.nspname NOT LIKE $$pg\_%$$)
SELECT json_build_object(
  $$format$$, $$dx082-manifest/1$$,
  $$database$$, current_database(),
  $$owner$$, (SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname = current_database()),
  $$server_version$$, current_setting($$server_version$$),
  $$created_at$$, to_char(now() AT TIME ZONE $$UTC$$, $$YYYY-MM-DD"T"HH24:MI:SS"Z"$$),
  $$last_migration$$, CASE WHEN to_regclass($$public._prisma_migrations$$) IS NULL THEN NULL ELSE
    (xpath($$/row/m/text()$$, query_to_xml($$SELECT max(migration_name) AS m FROM public._prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL$$, false, true, $$$$)))[1]::text END,
  $$roles$$, (SELECT coalesce(json_agg(r.rolname ORDER BY r.rolname), $$[]$$::json) FROM pg_roles r
     WHERE r.rolname NOT LIKE $$pg\_%$$ AND (
       r.oid = (SELECT datdba FROM pg_database WHERE datname = current_database())
       OR NOT r.rolsuper AND (
         EXISTS (SELECT 1 FROM pg_policy p WHERE r.oid = ANY (p.polroles))
         OR EXISTS (SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace, aclexplode(c.relacl) a
                     WHERE n.nspname = $$public$$ AND (a.grantee = r.oid OR c.relowner = r.oid))
         OR EXISTS (SELECT 1 FROM pg_proc f JOIN pg_namespace n ON n.oid = f.pronamespace
                     WHERE n.nspname = $$public$$ AND f.proowner = r.oid)))),
  $$database_settings$$, (SELECT coalesce(json_object_agg(split_part(c, $$=$$, 1), substr(c, strpos(c, $$=$$) + 1)), $${}$$::json)
     FROM pg_db_role_setting s, unnest(s.setconfig) AS c
     WHERE s.setrole = 0 AND s.setdatabase = (SELECT oid FROM pg_database WHERE datname = current_database())),
  $$table_count$$, (SELECT count(*) FROM t),
  $$row_count$$, (SELECT coalesce(sum(t.n), 0) FROM t),
  $$tables$$, (SELECT coalesce(json_object_agg(t.name, t.n ORDER BY t.name), $${}$$::json) FROM t)
) AS m'
