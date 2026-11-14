#!/usr/bin/env bash
# DX-081: drift entre prisma/schema.prisma y lo que dejan las migraciones.
#
# La base migrada NO coincide con el datamodel de Prisma a propósito: hay
# objetos que solo existen en SQL (FK compuestas por tenant, índices parciales
# o por expresión, nombres de FK propios). Por eso `migrate diff --exit-code`
# fallaría siempre. En su lugar se guarda la diferencia ESPERADA en
# prisma/drift-baseline.sql y la CI falla si cambia:
#
#   - cambiaste schema.prisma sin migración (o al revés) → arréglalo;
#   - añadiste a propósito un objeto solo-SQL → `npm run db:drift:update`
#     y revisa el diff de prisma/drift-baseline.sql en el PR.
#
# Uso: scripts/prisma-drift.sh check|update
# Requiere DIRECT_URL (o DATABASE_URL) de una base con TODAS las migraciones
# aplicadas (en la CI, tras db:test:setup).
set -euo pipefail

mode="${1:-check}"
url="${DIRECT_URL:-${DATABASE_URL:-}}"
if [ -z "$url" ]; then
  echo "prisma-drift: falta DIRECT_URL o DATABASE_URL" >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
baseline="$root/prisma/drift-baseline.sql"
current="$(mktemp)"
trap 'rm -f "$current"' EXIT

# El prisma del repo (package-lock), no uno global de otra versión mayor.
prisma="${PRISMA_BIN:-$root/node_modules/.bin/prisma}"
(cd "$root" && "$prisma" migrate diff \
  --from-url "$url" \
  --to-schema-datamodel prisma/schema.prisma \
  --script) >"$current"

case "$mode" in
  update)
    cp "$current" "$baseline"
    echo "prisma-drift: baseline actualizada ($(wc -l <"$baseline" | tr -d ' ') líneas). Revisa el diff antes de commitear."
    ;;
  check)
    if [ ! -f "$baseline" ]; then
      echo "prisma-drift: no existe prisma/drift-baseline.sql (npm run db:drift:update)" >&2
      exit 2
    fi
    if ! diff -u "$baseline" "$current"; then
      cat >&2 <<'EOF'

prisma-drift: schema.prisma y las migraciones ya no dan la diferencia esperada.
  - Si cambiaste schema.prisma, crea la migración que falta (o al revés).
  - Si añadiste a propósito un objeto solo-SQL que Prisma no modela,
    regenera la referencia con `npm run db:drift:update` y commitéala.
EOF
      exit 1
    fi
    echo "prisma-drift: sin drift (coincide con prisma/drift-baseline.sql)."
    ;;
  *)
    echo "uso: $0 check|update" >&2
    exit 2
    ;;
esac
