-- DX-320 (epic DX-311, decisión D4): el catálogo deja de tener código CUPS.
-- Dentalix es un producto global y basta el código interno del catálogo; no
-- se sustituye por ningún «código externo del procedimiento».
--
-- Segundo paso de la retirada: el código de esta misma versión ya no lee ni
-- escribe "cupsCode" (DTO, repositorio, demo y web), así que la columna se
-- puede borrar sin que la versión que se despliega la eche de menos.
--
-- Nada más la usa: ninguna vista, función, trigger, índice ni política RLS
-- de prisma/migrations menciona "cupsCode" (solo su CHECK
-- dental_catalog_items_cups_code_format, de DX-212, que cae con la columna).
-- Los CUPS que hubiera puesto una clínica eran un dato de catálogo, no
-- historia clínica: los diagnósticos CIE-10 y la sede de la evolución
-- (clinical_entries."locationId") no se tocan.
--
-- Idempotente (IF EXISTS) y segura con datos: DROP COLUMN solo marca la
-- columna como borrada (sin reescribir la tabla); lock_timeout corto para no
-- quedarse esperando detrás de una transacción larga.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "dental_catalog_items"
  DROP CONSTRAINT IF EXISTS "dental_catalog_items_cups_code_format";
ALTER TABLE "dental_catalog_items" DROP COLUMN IF EXISTS "cupsCode";
