# ADR 0001 · Búsqueda de pacientes indexable con RLS

- **Estado:** aceptada (DX-043, 2026-10-16)
- **Origen:** auditoría de BD 2026-10-15, hallazgo DB-004 (y DB-005).
- **Migración:** `prisma/migrations/20261017110000_patient_search_and_list_indexes`.
- **Medición:** [`docs/perf/DX-043.md`](../perf/DX-043.md).

## Contexto

La búsqueda de pacientes (`GET /patients?query=`) hacía un `OR` de tres
`ILIKE '%q%'` sobre nombre, apellido y documento. Con 50k pacientes en un
tenant tardaba ~110 ms, más otro tanto para el conteo, en cada pulsación del
buscador. Además "jose" no encontraba "José".

Un `ILIKE '%q%'` necesita un índice trigram (`pg_trgm`), pero eso no basta:
**con la RLS activa, Postgres no usa como condición de índice ninguna cláusula
cuyo operador no sea `LEAKPROOF`**. Las políticas son *security barrier*: las
cláusulas del usuario que podrían filtrar información (por un error o un
efecto lateral) se evalúan después del predicado de la política, fila a fila.
`~~` (`textlike`) y `~~*` (`texticlike`) tienen `proleakproof = false`, así
que el índice trigram existe pero el rol de la app (`dentalix_app`, sin
BYPASSRLS) nunca lo usa.

## Opciones

1. **Marcar `textlike`/`texticlike` como LEAKPROOF** (`ALTER FUNCTION
   pg_catalog.texticlike(text, text) LEAKPROOF`).
2. **Función `SECURITY DEFINER`** propiedad de un rol con BYPASSRLS que aplica
   ella misma el filtro de tenant del contexto.
3. **Solo búsqueda por prefijo** con `>=`/`<` (que sí son LEAKPROOF) sobre
   btree.

## Decisión

**Opción 2.** Se descarta la 1 porque **no es cierta**: `texticlike` puede
fallar según el DATO de la fila, no solo según el patrón.

```sql
SELECT 'abc' ILIKE 'x\';  -- false
SELECT 'xbc' ILIKE 'x\';  -- ERROR: LIKE pattern must not end with escape character
```

El error solo salta si el texto casa con el prefijo del patrón. Si el operador
fuera LEAKPROOF, el planner podría evaluarlo sobre filas de **otros tenants**
antes del filtro de la política (por ejemplo, en el recheck de un índice que
no lleva `tenantId`), y cualquier usuario podría usar el error como oráculo
para adivinar, carácter a carácter, nombres o documentos de otra clínica. Es
además un cambio global del catálogo (afecta a todas las tablas y consultas),
`pg_dump` no lo conserva y se perdería en silencio al restaurar o actualizar
Postgres. La opción 3 cambia el producto (no encuentra "pérez" dentro de
"Ana Pérez") y tampoco resuelve las tildes.

## Diseño

- **Normalización** `dx_search_normalize(text)`: `unaccent` (diccionario y
  función calificados por esquema) + `lower` + espacios colapsados. Se declara
  `IMMUTABLE` para poder usarla en una columna generada; es correcto mientras
  no cambie `unaccent.rules` (si cambiara: recalcular la columna y `REINDEX`).
- **Columna generada** `patients.search_text` (STORED) =
  normalizar(`firstName` ‖ ' ' ‖ `lastName` ‖ ' ' ‖ `docNumber`). La calcula
  Postgres en cada INSERT/UPDATE; la app no la escribe ni la lee (en Prisma es
  `@ignore`).
- **Índice** `patients_search_text_trgm_live_idx`: GIN `gin_trgm_ops`,
  parcial `WHERE "deletedAt" IS NULL`.
- **Rol** `dentalix_patient_search`: `NOLOGIN`, `BYPASSRLS`, sin superusuario.
  Privilegios mínimos: `USAGE` del esquema y `SELECT` solo de `id`,
  `tenantId`, `search_text`, `createdAt` y `deletedAt` de `patients` (ni
  nombres en claro ni datos clínicos).
- **Funciones** `dx_patient_search_ids(query, limit, offset)` y
  `dx_patient_search_count(query)`, propiedad de ese rol, `SECURITY DEFINER`,
  `SET search_path = pg_catalog, pg_temp`, `EXECUTE` solo para `dentalix_app`
  (revocado a `PUBLIC`):
  - El tenant sale de `current_setting('app.current_tenant')`, el mismo valor
    que usa la política RLS y que fija `PrismaService.runWithTenant` en la
    transacción. **No hay parámetro de tenant**: la firma solo tiene término y
    página. Sin tenant en el contexto devuelven nada.
  - Aplican el mismo predicado que la política (`"tenantId" = tenant`) más
    `"deletedAt" IS NULL` y `search_text LIKE '%' ‖ normalizar(q) ‖ '%'`, con
    `\`, `%` y `_` escapados (son literales, no comodines).
  - Devuelven **solo ids** (y un conteo). El repositorio lee después las filas
    completas con Prisma, bajo la RLS normal, y las reordena como vinieron.
  - `EXECUTE ... USING` dinámico: el plan se hace con el patrón real, así el
    planner sabe si es selectivo (trigram) o no (índice por fecha).
- Orden de resultados: `(createdAt DESC, id DESC)`, igual que el listado.

### Por qué es seguro

- La función no da a `dentalix_app` ninguna capacidad nueva: ese rol ya puede
  leer cualquier tenant fijando `app.current_tenant` (así funciona toda la
  RLS del producto; la defensa está en que la API fija el tenant desde el host
  y la sesión validados, nunca desde el cliente). La función lee el tenant de
  ese mismo sitio.
- El bypass de RLS queda en **un único punto auditable**, con un rol que no
  puede conectarse y que solo ve cinco columnas de una tabla.
- `search_path` fijo: un objeto con el mismo nombre en otro esquema (o en
  `pg_temp`) no puede secuestrar la función.
- La RLS de `patients` (y de todo lo demás) queda intacta y FORCE.
- Cubierto por `test/patient-search.int-spec.ts`: aislamiento entre dos
  tenants por el repositorio y llamando a las funciones directamente, sin
  tenant en contexto, firma sin tenant, `SECURITY DEFINER` + `search_path` +
  dueño `NOLOGIN`/`BYPASSRLS`/no superusuario.

## Consecuencias

- Búsqueda de un término raro entre 50k pacientes: ~110 ms → ~1 ms (página +
  conteo + filas), con Bitmap Index Scan trigram. "jose" encuentra "José";
  "nunez" encuentra "Núñez"; también busca por nombre completo y por documento
  parcial.
- Términos de 1-2 caracteres no tienen trigramas: el planner recorre el índice
  por fecha. Es correcto, solo menos selectivo.
- El rol de migración tiene que poder crear un rol con `BYPASSRLS`
  (superusuario en PG16, o `CREATEROLE` + `BYPASSRLS` propio). Es el owner
  `dentalix`, el mismo que ya exigen las migraciones con `row_security = off`.
  Los roles son del clúster: la migración lo crea si no existe y fija siempre
  sus atributos.
- `ADD COLUMN ... GENERATED STORED` reescribe `patients` una vez (bloqueo
  exclusivo durante la reescritura; < 1 s con 50k filas).
- Otros buscadores con el mismo patrón (`ILIKE` en catálogo, inventario y
  personal) siguen igual: volúmenes mucho menores. Si crecieran, se aplica el
  mismo patrón.
