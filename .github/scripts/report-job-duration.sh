#!/usr/bin/env bash
# DX-396 (TST-044): publica cuánto ha tardado el job (desde JOB_STARTED_AT,
# epoch en segundos que fija el primer paso) frente a su tope y avisa con un
# `::warning::` al pasar del 70 %, antes de que GitHub lo cancele.
#
# Uso: report-job-duration.sh <etiqueta> <tope-en-minutos>
# Escribe una tabla en $GITHUB_STEP_SUMMARY (o en stdout fuera de Actions).
set -euo pipefail

if [ "$#" -ne 2 ]; then
  echo "Uso: $0 <etiqueta> <tope-en-minutos>" >&2
  exit 2
fi

label="$1"
limit_min="$2"
started="${JOB_STARTED_AT:?Falta JOB_STARTED_AT (epoch del primer paso del job)}"
now="${JOB_FINISHED_AT:-$(date +%s)}"
warn_pct="${DURATION_WARN_PCT:-70}"

elapsed=$((now - started))
limit=$((limit_min * 60))
pct=$((elapsed * 100 / limit))
human="$((elapsed / 60)) min $((elapsed % 60)) s"

summary="${GITHUB_STEP_SUMMARY:-/dev/stdout}"
{
  echo "### Duración: ${label}"
  echo
  echo "| Duración | Tope | Uso | Aviso desde |"
  echo "|---|---|---|---|"
  echo "| ${human} (${elapsed} s) | ${limit_min} min | ${pct} % | ${warn_pct} % |"
} >>"$summary"

echo "${label}: ${human} de ${limit_min} min (${pct} %)."
if [ "$pct" -ge "$warn_pct" ]; then
  echo "::warning title=${label} cerca del tope::${human} son el ${pct} % de timeout-minutes (${limit_min} min). Reparte más shards o sube el tope antes de que GitHub lo cancele."
fi
