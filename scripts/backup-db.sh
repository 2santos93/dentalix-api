#!/usr/bin/env bash
# DX-082 · Copia lógica de la BD: `pg_dump -Fc` cifrado con age (clave pública).
#
#   PGPASSFILE=/run/secrets/pgpass BACKUP_DATABASE_URL=postgresql://dentalix_backup@host:5432/dentalix \
#   BACKUP_AGE_RECIPIENTS_FILE=/run/secrets/backup-recipients.txt \
#     scripts/backup-db.sh --out-dir /var/backups/dentalix [--prefix dentalix-prod] \
#       [--prune [--daily 35] [--monthly 12]]
#
# Conexión (la primera que haya; nunca credenciales en el script ni en argv):
#   BACKUP_DATABASE_URL  rol de copias: LOGIN, BYPASSRLS, pg_read_all_data, sin
#                        SUPERUSER (README, «Copias de la BD»). Con FORCE RLS
#                        (DX-113) el owner SIN BYPASSRLS no puede volcar: pg_dump
#                        aborta con «query would be affected by row-level
#                        security policy» en vez de copiar tablas vacías.
#   DIRECT_URL           el owner, válido solo si tiene BYPASSRLS o es superusuario
#                        (Postgres local o de CI).
#   PGHOST/PGPORT/PGUSER/PGDATABASE (+ PGPASSFILE)  variables de libpq.
# Cifrado (age, X25519): BACKUP_AGE_RECIPIENTS_FILE (una o más claves públicas
#   `age1…`, una por línea) o BACKUP_AGE_RECIPIENT (una clave pública). La
#   clave privada NO está aquí ni en la app: la guardan quienes restauran.
#
# Escribe en --out-dir (umask 077), con timestamp UTC:
#   <prefijo>_AAAAMMDDTHHMMSSZ.dump.age         volcado cifrado (nunca en claro en disco)
#   <prefijo>_AAAAMMDDTHHMMSSZ.dump.age.sha256  `sha256sum -c` desde el directorio
#   <prefijo>_AAAAMMDDTHHMMSSZ.manifest.json    conteo de filas por tabla, rol
#                                               owner, roles y ajustes de la BD
# El conteo se hace en la MISMA instantánea que el volcado (pg_export_snapshot
# + pg_dump --snapshot): restore-check.sh lo compara fila a fila. Solo nombres
# de tabla y números: ningún dato clínico. Por stdout, una línea JSON de resumen.
#
# --prune aplica scripts/backup-retention.sh a las copias <prefijo>_* de
# --out-dir y borra las `delete` con sus ficheros hermanos; las `review`
# (mensuales de más de 12 meses, DX-039) nunca se borran solas.
#
# Salida: 0 bien; 1 fallo del volcado/cifrado; 2 uso o configuración;
# 4 la copia se hizo pero la retención se negó a borrar (ver stderr).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=SCRIPTDIR/lib/dx082-common.sh
. "$here/lib/dx082-common.sh"

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//'
}

out_dir=''
prefix=''
prune=0
daily=35
monthly=12
while (($# > 0)); do
  case "$1" in
    --out-dir) out_dir="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --prefix) prefix="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --prune) prune=1; shift ;;
    --daily) daily="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    --monthly) monthly="${2-}"; shift 2 || { usage >&2; exit 2; } ;;
    -h | --help) usage; exit 0 ;;
    *) usage >&2; exit 2 ;;
  esac
done
[[ -n "$out_dir" ]] || { usage >&2; exit 2; }

# Clave pública: antes que nada, para no volcar si no se puede cifrar.
recipients="${BACKUP_AGE_RECIPIENTS_FILE:-}"
if [[ -z "$recipients" && -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
  dx_die 'falta la clave pública: BACKUP_AGE_RECIPIENTS_FILE (fichero con claves age1…) o BACKUP_AGE_RECIPIENT' 2
fi
if [[ -n "$recipients" ]]; then
  [[ -r "$recipients" ]] || dx_die "no se puede leer BACKUP_AGE_RECIPIENTS_FILE" 2
  if grep -q 'AGE-SECRET-KEY-' "$recipients"; then
    dx_die 'BACKUP_AGE_RECIPIENTS_FILE contiene una clave PRIVADA: aquí solo va la pública (age1…)' 2
  fi
fi

# Conexión: la URL se reparte en PG* y se borra del entorno de los hijos.
url="${BACKUP_DATABASE_URL:-${DIRECT_URL:-}}"
if [[ -n "$url" ]]; then
  dx_export_pg_url "$url"
elif [[ -z "${PGDATABASE:-}" ]]; then
  dx_die 'falta la conexión: BACKUP_DATABASE_URL (rol de copias con BYPASSRLS), DIRECT_URL o PGHOST/PGUSER/PGDATABASE' 2
fi
unset url BACKUP_DATABASE_URL DIRECT_URL DATABASE_URL
[[ -n "${PGDATABASE:-}" ]] || dx_die 'la conexión no nombra la base (…/<base> o PGDATABASE)' 2

dx_require_tools pg_dump psql age sha256sum

db="$PGDATABASE"
prefix="${prefix:-dentalix-${db}}"
[[ "$prefix" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] || dx_die "--prefix solo admite letras, dígitos, «.», «_» y «-»" 2

umask 077
mkdir -p "$out_dir"
ts="$(date -u +%Y%m%dT%H%M%SZ)"
base="${prefix}_${ts}"
dump="$base.dump.age"
[[ ! -e "$out_dir/$dump" ]] || dx_die "ya existe $dump en --out-dir" 2
work="$(mktemp -d "$out_dir/.${base}.XXXXXX")"
snap_pid=''
# shellcheck disable=SC2317,SC2329 # la invoca el trap EXIT (SC2317 en shellcheck < 0.10)
cleanup() {
  if [[ -n "$snap_pid" ]]; then kill "$snap_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

started="$(dx_now_ms)"

# Sesión que exporta la instantánea: el conteo y pg_dump ven los mismos datos.
# row_security=off hace que un rol sin BYPASSRLS falle en vez de contar 0.
coproc SNAP { exec psql -X -q -A -t -v ON_ERROR_STOP=1 -v VERBOSITY=terse 2>"$work/psql.err"; }
# shellcheck disable=SC2153 # SNAP_PID lo define el coproc SNAP
snap_pid="$SNAP_PID"
exec {snap_out}>&"${SNAP[1]}" {snap_in}<&"${SNAP[0]}"
printf '%s\n' \
  'SET row_security = off;' \
  'SET statement_timeout = 0;' \
  'SET idle_in_transaction_session_timeout = 0;' \
  'BEGIN ISOLATION LEVEL REPEATABLE READ, READ ONLY;' \
  'SELECT pg_export_snapshot();' >&"$snap_out"
snapshot=''
IFS= read -r -t 120 snapshot <&"$snap_in" || true
if ! [[ "$snapshot" =~ ^[0-9A-Fa-f]+-[0-9A-Fa-f]+-[0-9]+$ ]]; then
  dx_log "$(dx_pg_errors "$work/psql.err")"
  dx_die 'no se pudo abrir la instantánea en la BD (conexión o permisos; la URL no se muestra)'
fi

printf '%s;\n' "$DX_COUNTS_SQL" >&"$snap_out"
manifest=''
IFS= read -r -t 3600 manifest <&"$snap_in" || true
if [[ "$manifest" != \{*\} ]]; then
  dx_log "$(dx_pg_errors "$work/psql.err")"
  if grep -q 'row-level security' "$work/psql.err" 2>/dev/null; then
    dx_log 'Pista: el rol no tiene BYPASSRLS y las tablas tienen FORCE RLS; usa el rol de copias (README, «Copias de la BD»).'
  fi
  dx_die 'no se pudo contar las filas de la instantánea'
fi

dump_started="$(dx_now_ms)"
age_args=()
if [[ -n "$recipients" ]]; then age_args+=(-R "$recipients"); else age_args+=(-r "$BACKUP_AGE_RECIPIENT"); fi
if ! pg_dump -Fc --create --no-password --lock-wait-timeout=120s \
  --snapshot="$snapshot" 2>"$work/pg_dump.err" |
  age "${age_args[@]}" -o "$work/$dump" 2>"$work/age.err"; then
  dx_log "$(dx_pg_errors "$work/pg_dump.err")"
  dx_log "$(dx_pg_errors "$work/age.err")"
  if grep -q 'row-level security' "$work/pg_dump.err" 2>/dev/null; then
    dx_log 'Pista: el rol no tiene BYPASSRLS y las tablas tienen FORCE RLS; usa el rol de copias (README, «Copias de la BD»).'
  fi
  dx_die 'falló pg_dump o el cifrado: no queda ninguna copia de esta ejecución'
fi
dump_ms=$(($(dx_now_ms) - dump_started))
[[ -s "$work/$dump" ]] || dx_die 'el volcado cifrado salió vacío'

printf 'COMMIT;\n\\q\n' >&"$snap_out"
exec {snap_out}>&- {snap_in}<&-
wait "$snap_pid" || true
snap_pid=''

(cd "$work" && sha256sum "$dump" >"$dump.sha256")
sha="$(cut -d' ' -f1 "$work/$dump.sha256")"
bytes="$(wc -c <"$work/$dump" | tr -d ' ')"
pg_dump_version="$(pg_dump --version 2>/dev/null | head -n1 || true)"
printf '%s\n' "${manifest%\}}, \"file\": $(dx_json_str "$dump"), \"sha256\": \"$sha\", \"bytes\": $bytes, \"pg_dump_version\": $(dx_json_str "$pg_dump_version")}" \
  >"$work/$base.manifest.json"

# El volcado se mueve el último: si está, están sus hermanos.
mv "$work/$base.manifest.json" "$out_dir/"
mv "$work/$dump.sha256" "$out_dir/"
mv "$work/$dump" "$out_dir/"

tables=0
rows=0
[[ "$manifest" =~ \"table_count\"\ ?:\ ?([0-9]+) ]] && tables="${BASH_REMATCH[1]}"
[[ "$manifest" =~ \"row_count\"\ ?:\ ?([0-9]+) ]] && rows="${BASH_REMATCH[1]}"
total_ms=$(($(dx_now_ms) - started))
dx_log "Copia: $dump ($bytes bytes cifrados, $tables tablas, $rows filas; pg_dump+age ${dump_ms} ms, total ${total_ms} ms)"

status=0
if ((prune == 1)); then
  # Solo ESTA serie: con --prefix dentalix-a, el glob `dentalix-a_*` también
  # casaría con las copias de `dentalix-a_staging`.
  listing="$(find "$out_dir" -maxdepth 1 -type f -name "${prefix}_*.dump.age" -printf '%f\n' |
    grep -E "^${prefix//./\\.}_[0-9]{8}T[0-9]{6}Z\.dump\.age\$" | sort || true)"
  if plan="$(printf '%s\n' "$listing" | "$here/backup-retention.sh" --daily "$daily" --monthly "$monthly")"; then
    deleted=0
    review=0
    while IFS=$'\t' read -r action name _reason; do
      case "$action" in
        delete)
          rm -f -- "$out_dir/$name" "$out_dir/$name.sha256" "$out_dir/${name%.dump.age}.manifest.json"
          deleted=$((deleted + 1))
          ;;
        review) review=$((review + 1)) ;;
      esac
    done <<<"$plan"
    dx_log "Retención: $deleted copias borradas; $review mensuales de más de ${monthly} meses pendientes de revisión (DX-039, no se borran solas)"
  else
    dx_log 'Retención: no se borró nada (ver el error de backup-retention.sh arriba)'
    status=4
  fi
fi

printf '{"event":"backup.ok","file":%s,"bytes":%s,"sha256":"%s","tables":%s,"rows":%s,"dump_ms":%s,"total_ms":%s}\n' \
  "$(dx_json_str "$dump")" "$bytes" "$sha" "$tables" "$rows" "$dump_ms" "$total_ms"
exit "$status"
