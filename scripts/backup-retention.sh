#!/usr/bin/env bash
# DX-082 · Qué copias de la BD conservar: N diarias + M mensuales.
#
#   ls backups/ | scripts/backup-retention.sh [--now 2026-10-31T12:00:00Z]
#        [--daily 35] [--monthly 12] [--max-age-hours 48]
#   aws s3 ls s3://<bucket>/db/ | awk '{print $4}' | scripts/backup-retention.sh
#
# Lee por stdin un nombre (o clave con prefijo) por línea y escribe, en el
# mismo orden, `acción<TAB>nombre<TAB>motivo`:
#   keep    daily | monthly | daily+monthly | unrecognized
#   delete  expired-daily | superseded-same-day
#   review  monthly-expired-review-dx039
# Solo se reconoce `<algo>_AAAAMMDDTHHMMSSZ.dump.age` (lo que escribe
# backup-db.sh); todo lo demás (sidecars .sha256/.manifest.json, otros
# ficheros) es `keep unrecognized`: nunca se borra lo que no se entiende.
# Cada serie (todo lo que va antes de `_AAAAMMDDTHHMMSSZ.dump.age`, ruta
# incluida) se evalúa por separado: copias de otra base (`dentalix-a` y
# `dentalix-a_staging`) o de otra carpeta (`db/daily/` y `db/monthly/`) no
# se «sustituyen» entre sí.
#
# Política (días y meses en UTC, contados desde --now):
#   - diaria: la ÚLTIMA copia de cada uno de los N últimos días (hoy incluido);
#   - mensual: la PRIMERA copia de cada uno de los M últimos meses (este
#     incluido);
#   - la primera copia de un mes más antiguo que M meses es `review`, nunca
#     `delete`: puede contener historias clínicas dentro del plazo legal de
#     conservación (15 años, DX-039) o datos que ya se suprimieron en la BD
#     viva. Solo una persona, revisando DX-039, decide si se borra o se
#     archiva en frío (runbook docs/operacion/backups.md).
#
# Guardas (salida 3, sin ninguna línea en stdout: el que llama no borra nada):
#   - la copia más reciente tiene más de --max-age-hours (las copias están
#     fallando: no es momento de borrar las buenas);
#   - hay una copia con fecha futura (más de 5 min): reloj mal.
# Salida 2: argumentos inválidos.
set -euo pipefail

usage() {
  sed -n '2,35p' "$0" | sed 's/^# \{0,1\}//' >&2
}

now_iso=''
daily=35
monthly=12
max_age_hours=48
while (($# > 0)); do
  case "$1" in
    --now) now_iso="${2-}"; shift 2 || { usage; exit 2; } ;;
    --daily) daily="${2-}"; shift 2 || { usage; exit 2; } ;;
    --monthly) monthly="${2-}"; shift 2 || { usage; exit 2; } ;;
    --max-age-hours) max_age_hours="${2-}"; shift 2 || { usage; exit 2; } ;;
    -h | --help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

for v in "$daily" "$monthly" "$max_age_hours"; do
  if ! [[ "$v" =~ ^[1-9][0-9]{0,4}$ ]]; then
    echo "ERROR: --daily, --monthly y --max-age-hours son enteros ≥ 1 (recibido «$v»)" >&2
    exit 2
  fi
done

if [[ -n "$now_iso" ]]; then
  if ! [[ "$now_iso" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
    ! now="$(date -u -d "$now_iso" +%s 2>/dev/null)"; then
    echo "ERROR: --now debe ser AAAA-MM-DDTHH:MM:SSZ (recibido «$now_iso»)" >&2
    exit 2
  fi
else
  now="$(date -u +%s)"
fi

today=$((now / 86400))
now_month=$((10#$(date -u -d "@$now" +%Y) * 12 + 10#$(date -u -d "@$now" +%m) - 1))

names=()
epochs=()
series=()
while IFS= read -r line || [[ -n "$line" ]]; do
  line="${line%$'\r'}"
  [[ -n "$line" ]] || continue
  names+=("$line")
  if [[ "$line" =~ _([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})Z\.dump\.age$ ]]; then
    m=("${BASH_REMATCH[@]}")
    if e="$(date -u -d "${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}" +%s 2>/dev/null)"; then
      epochs+=("$e")
      series+=("${line%_*}")
      continue
    fi
  fi
  epochs+=('')
  series+=('')
done

((${#names[@]} > 0)) || exit 0

# Guardas y, por día y por mes, la copia que se queda.
declare -A last_of_day first_of_month
newest=''
for i in "${!names[@]}"; do
  e="${epochs[$i]}"
  [[ -n "$e" ]] || continue
  if ((e > now + 300)); then
    echo "ERROR: «${names[$i]}» tiene fecha en el futuro respecto de $(date -u -d "@$now" +%FT%TZ): no se borra nada (¿reloj mal?)" >&2
    exit 3
  fi
  [[ -z "$newest" || e -gt newest ]] && newest="$e"
  d=$((e / 86400))
  mo=$((10#$(date -u -d "@$e" +%Y) * 12 + 10#$(date -u -d "@$e" +%m) - 1))
  kd="${series[$i]}|$d"
  km="${series[$i]}|$mo"
  j="${last_of_day[$kd]-}"
  if [[ -z "$j" ]] || ((e >= ${epochs[$j]})); then last_of_day[$kd]="$i"; fi
  j="${first_of_month[$km]-}"
  if [[ -z "$j" ]] || ((e < ${epochs[$j]})); then first_of_month[$km]="$i"; fi
done

if [[ -n "$newest" ]] && ((now - newest > max_age_hours * 3600)); then
  echo "ERROR: la copia más reciente es de $(date -u -d "@$newest" +%FT%TZ), más de ${max_age_hours} h: no se borra nada hasta que vuelva a haber copias recientes" >&2
  exit 3
fi

for i in "${!names[@]}"; do
  name="${names[$i]}"
  e="${epochs[$i]}"
  if [[ -z "$e" ]]; then
    printf 'keep\t%s\tunrecognized\n' "$name"
    continue
  fi
  d=$((e / 86400))
  mo=$((10#$(date -u -d "@$e" +%Y) * 12 + 10#$(date -u -d "@$e" +%m) - 1))
  is_daily=0
  is_monthly=0
  if ((today - d < daily)) && [[ "${last_of_day[${series[$i]}|$d]}" == "$i" ]]; then is_daily=1; fi
  if [[ "${first_of_month[${series[$i]}|$mo]}" == "$i" ]]; then
    if ((now_month - mo < monthly)); then is_monthly=1; else is_monthly=2; fi
  fi
  if ((is_daily == 1 && is_monthly == 1)); then
    printf 'keep\t%s\tdaily+monthly\n' "$name"
  elif ((is_daily == 1)); then
    printf 'keep\t%s\tdaily\n' "$name"
  elif ((is_monthly == 1)); then
    printf 'keep\t%s\tmonthly\n' "$name"
  elif ((is_monthly == 2)); then
    printf 'review\t%s\tmonthly-expired-review-dx039\n' "$name"
  elif ((today - d < daily)); then
    printf 'delete\t%s\tsuperseded-same-day\n' "$name"
  else
    printf 'delete\t%s\texpired-daily\n' "$name"
  fi
done
