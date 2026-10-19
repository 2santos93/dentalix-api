-- DX-226 (DB-037), tras DX-027: la caja por turno también graba la hora del
-- servidor en UTC. Sus triggers ponían la apertura, el cierre, la reapertura
-- y el alta de un ajuste con CURRENT_TIMESTAMP, que al guardarse en
-- `timestamp` sin zona se convierte a la zona de la SESIÓN (con
-- America/Bogota, 5 h antes); la API compara esas horas con instantes UTC
-- (cajas que se solapan con un día civil, payment-cash-session.ts).
--
-- Mismos cuerpos, nombres, firmas, dueño y search_path que en
-- 20261018140200_dx027_cash_sessions; solo cambia la fuente de hora, a
-- `pg_catalog.timezone('UTC', pg_catalog.now())`, tanto al ponerla como al
-- compararla con la de la fila hermana de la misma transacción (fondo con su
-- apertura, arqueo con su cierre, estado con su cierre o reapertura): las dos
-- tienen que salir del MISMO cálculo. No toca filas ni triggers.

SET LOCAL lock_timeout = '5s';

-- cash_sessions: nace OPEN con la hora del servidor; solo cambian estado,
-- cierre y nº de reaperturas, y cada transición tiene que venir con su fila
-- (cierre o reapertura) en la misma transacción.
CREATE OR REPLACE FUNCTION public.dx_cash_session_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cash_sessions no admite %: una caja no se borra (DX-027)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."openedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."status" <> 'OPEN' OR NEW."reopenCount" <> 0 OR NEW."closedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Una caja nace abierta (DX-027)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF (NEW."id", NEW."tenantId", NEW."locationId", NEW."openedById", NEW."openedAt", NEW."notes")
     IS DISTINCT FROM
     (OLD."id", OLD."tenantId", OLD."locationId", OLD."openedById", OLD."openedAt", OLD."notes")
  THEN
    RAISE EXCEPTION 'cash_sessions es inalterable: la apertura no se edita (DX-027)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF OLD."status" = 'OPEN' AND NEW."status" = 'CLOSED' THEN
    NEW."closedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."reopenCount" <> OLD."reopenCount" OR NOT EXISTS (
      SELECT 1 FROM public.cash_session_closings c
       WHERE c."tenantId" = NEW."tenantId" AND c."sessionId" = NEW."id"
         AND c."sequence" = NEW."reopenCount" + 1
         AND c."closedById" = NEW."closedById"
         AND c."closedAt" = pg_catalog.timezone('UTC', pg_catalog.now())::timestamp(3)
    ) THEN
      RAISE EXCEPTION 'Una caja solo se cierra con su arqueo (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'CLOSED' AND NEW."status" = 'OPEN' THEN
    IF NEW."reopenCount" <> OLD."reopenCount" + 1 OR NOT EXISTS (
      SELECT 1 FROM public.cash_session_reopenings r
       WHERE r."tenantId" = NEW."tenantId" AND r."sessionId" = NEW."id"
         AND r."sequence" = NEW."reopenCount"
         AND r."reopenedAt" = pg_catalog.timezone('UTC', pg_catalog.now())::timestamp(3)
    ) THEN
      RAISE EXCEPTION 'Una caja cerrada solo se reabre con motivo, por un administrador (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'cash_sessions es inalterable: un cierre no se edita; una corrección es un ajuste (DX-027)'
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


-- Filas hijas inalterables: solo INSERT, y solo en la transacción que crea su
-- padre (la apertura para el fondo; el cierre para las líneas).
CREATE OR REPLACE FUNCTION public.dx_cash_child_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF TG_TABLE_NAME = 'cash_session_floats' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.cash_sessions s
         WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
           AND s."status" = 'OPEN' AND s."reopenCount" = 0
           AND s."openedAt" = pg_catalog.timezone('UTC', pg_catalog.now())::timestamp(3)
      ) THEN
        RAISE EXCEPTION 'El fondo inicial solo se registra al abrir la caja (DX-027)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    ELSIF TG_TABLE_NAME = 'cash_session_closing_lines' THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.cash_session_closings c
         WHERE c."tenantId" = NEW."tenantId" AND c."id" = NEW."closingId"
           AND c."closedAt" = pg_catalog.timezone('UTC', pg_catalog.now())::timestamp(3)
      ) THEN
        RAISE EXCEPTION 'El arqueo solo se registra con su cierre (DX-027)'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION '% es inalterable: un cierre no se edita; una corrección es un ajuste (DX-027)', TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END;
$$;


-- Cierres y reaperturas: append-only, con la hora del servidor; el cierre
-- solo de una caja abierta y con la vuelta que le toca, la reapertura solo de
-- una cerrada y de su último cierre.
CREATE OR REPLACE FUNCTION public.dx_cash_event_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION '% es inalterable: append-only (DX-027)', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_TABLE_NAME = 'cash_session_closings' THEN
    NEW."closedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
         AND s."status" = 'OPEN' AND s."reopenCount" + 1 = NEW."sequence"
    ) THEN
      RAISE EXCEPTION 'Solo se cierra una caja abierta (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    NEW."reopenedAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
        JOIN public.cash_session_closings c
          ON c."tenantId" = s."tenantId" AND c."sessionId" = s."id"
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
         AND s."status" = 'CLOSED' AND s."reopenCount" + 1 = NEW."sequence"
         AND c."id" = NEW."closingId" AND c."sequence" = NEW."sequence"
    ) THEN
      RAISE EXCEPTION 'Solo se reabre una caja cerrada, desde su último cierre (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;


-- Ajustes: el abono es de la misma clínica y sede; la caja de destino está
-- abierta y es de la sede; la de origen, de la sede. Lo único que cambia
-- después es unir un ajuste pendiente a una caja abierta, una vez.
CREATE OR REPLACE FUNCTION public.dx_cash_adjustment_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF public.dx_cash_is_superuser() THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'cash_session_adjustments no admite %: un ajuste no se borra (DX-027)', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."sessionId" IS NOT NULL OR NEW."sessionId" IS NULL
       OR (NEW."id", NEW."tenantId", NEW."locationId", NEW."kind", NEW."paymentId",
           NEW."originalSessionId", NEW."currency", NEW."method", NEW."amount",
           NEW."reason", NEW."createdById", NEW."createdAt")
          IS DISTINCT FROM
          (OLD."id", OLD."tenantId", OLD."locationId", OLD."kind", OLD."paymentId",
           OLD."originalSessionId", OLD."currency", OLD."method", OLD."amount",
           OLD."reason", OLD."createdById", OLD."createdAt")
    THEN
      RAISE EXCEPTION 'cash_session_adjustments es inalterable: un ajuste pendiente solo se une una vez a una caja abierta (DX-027)'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  ELSE
    NEW."createdAt" := pg_catalog.timezone('UTC', pg_catalog.now());
    IF NEW."paymentId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.payments p
       WHERE p."id" = NEW."paymentId" AND p."tenantId" = NEW."tenantId"
         AND p."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'El abono del ajuste no es de esta clínica y sede (DX-027)'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
    IF NEW."originalSessionId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.cash_sessions s
       WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."originalSessionId"
         AND s."locationId" = NEW."locationId"
    ) THEN
      RAISE EXCEPTION 'La caja de origen del ajuste no es de esta sede (DX-027)'
        USING ERRCODE = 'foreign_key_violation';
    END IF;
  END IF;

  IF NEW."sessionId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.cash_sessions s
     WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sessionId"
       AND s."locationId" = NEW."locationId" AND s."status" = 'OPEN'
  ) THEN
    RAISE EXCEPTION 'Un ajuste solo entra en una caja abierta de su sede (DX-027)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

