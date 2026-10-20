-- DX-225 (DB-035): pacientes de un móvil con índice también bajo RLS.
--
-- Por qué: `dx_phone_tail("phone") = $1` se expande a right(regexp_replace())
-- y ninguna de las dos es LEAKPROOF: bajo RLS FORCE quedaba en Filter y el
-- índice de expresión de DX-128 solo aportaba el prefijo "tenantId" (Seq Scan
-- de todos los pacientes con una expresión regular por fila). Una columna
-- comparada con `=` (`texteq`, LEAKPROOF) sí es condición de índice.
--
-- Cambios (solo esquema; el relleno y los índices van en ficheros propios):
--   patients."phoneTail"   últimos 8 dígitos del teléfono (dx_phone_tail, la
--                          misma regla de DX-128). NULL sin teléfono. Deriva
--                          del teléfono: mismo dato personal, misma tabla y
--                          misma RLS; no se registra en logs.
--   dx_patients_phone_tail()   trigger BEFORE INSERT OR UPDATE OF "phone",
--                          "phoneTail": lo calcula siempre la BD (un valor
--                          escrito a mano se sobrescribe). search_path fijo.
--
-- Bloqueo: ADD COLUMN sin DEFAULT no reescribe la tabla (solo catálogo);
-- CREATE TRIGGER toma SHARE ROW EXCLUSIVE un instante. lock_timeout evita
-- quedar encolado detrás de una transacción larga y bloquear a los demás.
--
-- Compatible hacia atrás: el código anterior no lee ni escribe la columna y
-- su consulta por dx_phone_tail() sigue funcionando (la función se queda).
-- Las filas existentes quedan con NULL hasta el relleno por lotes
-- (20261020100200), que va en su propia migración sin DDL (DB-029).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patients" ADD COLUMN "phoneTail" TEXT;

CREATE FUNCTION public."dx_patients_phone_tail"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  NEW."phoneTail" := public.dx_phone_tail(NEW."phone");
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patients_phone_tail"
  BEFORE INSERT OR UPDATE OF "phone", "phoneTail" ON "patients"
  FOR EACH ROW EXECUTE FUNCTION public."dx_patients_phone_tail"();
