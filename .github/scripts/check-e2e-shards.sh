#!/usr/bin/env bash
# DX-396 (TST-044): comprueba que el reparto de la e2e en shards corre cada
# spec EXACTAMENTE una vez: la unión de las listas de los shards (una por
# fichero, como las deja `jest --listTests --shard=i/n`) no repite ningún spec
# y coincide con la lista completa (`jest --listTests` sin shard).
#
# Uso: check-e2e-shards.sh <lista-completa> <lista-shard-1> [<lista-shard-2> ...]
# Rutas relativas a la raíz del repo, una por línea. Sale con 1 si sobra, falta
# o se repite algún spec, o si un shard viene vacío.
set -euo pipefail

if [ "$#" -lt 2 ]; then
  echo "Uso: $0 <lista-completa> <lista-shard>..." >&2
  exit 2
fi

full="$1"
shift

if [ ! -s "$full" ]; then
  echo "::error title=Reparto de la e2e::La lista completa ($full) está vacía."
  exit 1
fi

status=0
for shard in "$@"; do
  if [ ! -s "$shard" ]; then
    echo "::error title=Reparto de la e2e::El shard $shard no tiene specs."
    status=1
  fi
done

union="$(mktemp)"
expected="$(mktemp)"
trap 'rm -f "$union" "$expected"' EXIT
sort "$@" >"$union"
sort -u "$full" >"$expected"

repeated="$(uniq -d "$union")"
missing="$(comm -23 "$expected" <(sort -u "$union"))"
extra="$(comm -13 "$expected" <(sort -u "$union"))"

if [ -n "$repeated" ]; then
  echo "::error title=Reparto de la e2e::Specs en más de un shard:"
  echo "$repeated"
  status=1
fi
if [ -n "$missing" ]; then
  echo "::error title=Reparto de la e2e::Specs que no corre ningún shard:"
  echo "$missing"
  status=1
fi
if [ -n "$extra" ]; then
  echo "::error title=Reparto de la e2e::Specs de los shards que no están en la lista completa:"
  echo "$extra"
  status=1
fi

if [ "$status" -eq 0 ]; then
  echo "Reparto de la e2e correcto: $(wc -l <"$expected") specs en $# shards, cada uno una sola vez."
  for shard in "$@"; do
    echo "  $(basename "$shard"): $(wc -l <"$shard") specs"
  done
fi
exit "$status"
