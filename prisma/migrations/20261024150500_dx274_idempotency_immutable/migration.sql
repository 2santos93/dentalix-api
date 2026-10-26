-- DX-274: la clave de idempotencia y su huella (migración 20261024150400) son
-- inalterables como el resto de la identidad del gasto y del pago.
--
-- Hasta ahora los triggers `dx_expense_guard` y `dx_expense_payment_guard` no
-- comparaban las dos columnas nuevas: una anulación o una edición podía
-- reescribirlas y romper las repeticiones (el original ya no se encontraría, o
-- se aceptaría otro cuerpo con la misma clave). Se reemplazan las funciones
-- (CREATE OR REPLACE: los triggers que las usan no se tocan) con las columnas
-- en la tupla comparada.
--
-- Además, la categoría propia es única entre las vivas SIN mayúsculas, tildes ni
-- espacios de más (la misma regla `dx_search_normalize` de `categoryKey`): el
-- único exacto anterior no cerraba la carrera «Café» / «cafe». El nuevo lo
-- subsume (dos nombres iguales también lo son normalizados), así que se
-- reemplaza. `expense_categories` es nueva en este despliegue: no hay filas que
-- puedan chocar.

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.dx_expense_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'expenses no admite %: un gasto no se borra, se anula (DX-274)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un gasto nace sin anular (DX-274)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenantId", NEW."createdById", NEW."createdAt",
      NEW."idempotencyKey", NEW."idempotencyFingerprint")
     IS DISTINCT FROM (OLD."id", OLD."tenantId", OLD."createdById", OLD."createdAt",
      OLD."idempotencyKey", OLD."idempotencyFingerprint")
  THEN
    RAISE EXCEPTION 'expenses es inalterable en su identidad: clínica, autor, alta y clave de idempotencia no cambian (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Soporte: vacío -> lleno una vez; después no cambia.
  IF OLD."attachmentKey" IS NOT NULL
     AND (NEW."attachmentKey", NEW."attachmentMime", NEW."attachmentSize",
          NEW."attachmentSha256", NEW."attachmentName")
         IS DISTINCT FROM
         (OLD."attachmentKey", OLD."attachmentMime", OLD."attachmentSize",
          OLD."attachmentSha256", OLD."attachmentName")
  THEN
    RAISE EXCEPTION 'El soporte de un gasto se fija una vez y no cambia (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  -- Anulación: vacía -> llena una vez, con la hora del servidor; no se deshace.
  IF OLD."voidedAt" IS NOT NULL THEN
    IF (NEW."voidedAt", NEW."voidedById", NEW."voidReason")
       IS DISTINCT FROM (OLD."voidedAt", OLD."voidedById", OLD."voidReason")
    THEN
      RAISE EXCEPTION 'Un gasto anulado no se anula de nuevo ni se reactiva (DX-274)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSIF NEW."voidedAt" IS NOT NULL THEN
    NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  END IF;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.dx_expense_payment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'expense_payments no admite %: un pago no se borra, se anula (DX-274)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un pago de gasto nace sin anular (DX-274)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."cashSessionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."cashSessionId"
         AND s."locationId" = NEW."locationId" AND s."status" = 'OPEN'
    ) THEN
      RAISE EXCEPTION 'Una salida de caja solo entra en una caja abierta de su sede (DX-274)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: solo la anulación (vacía -> llena), una vez; nada más cambia.
  IF OLD."voidedAt" IS NOT NULL OR NEW."voidedAt" IS NULL
     OR (NEW."id", NEW."tenantId", NEW."expenseId", NEW."locationId", NEW."amount",
         NEW."currency", NEW."method", NEW."paidOn", NEW."cashSessionId",
         NEW."createdById", NEW."createdAt",
         NEW."idempotencyKey", NEW."idempotencyFingerprint")
        IS DISTINCT FROM
        (OLD."id", OLD."tenantId", OLD."expenseId", OLD."locationId", OLD."amount",
         OLD."currency", OLD."method", OLD."paidOn", OLD."cashSessionId",
         OLD."createdById", OLD."createdAt",
         OLD."idempotencyKey", OLD."idempotencyFingerprint")
  THEN
    RAISE EXCEPTION 'expense_payments es inalterable: un pago solo se anula, una vez (DX-274)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  NEW."voidedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
  RETURN NEW;
END;
$$;

DROP INDEX "expense_categories_tenant_name_key";
CREATE UNIQUE INDEX "expense_categories_tenant_name_norm_key"
  ON "expense_categories"("tenantId", public.dx_search_normalize("name"))
  WHERE "deletedAt" IS NULL;
