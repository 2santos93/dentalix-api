-- DX-425 (DB-061, DB-062, DB-065): la firma a distancia impone en la BD lo que
-- hasta hoy solo cuidaba la app.
--
-- Cambios (esta migración, transaccional y aditiva):
--   1. Duplicados vivos: si ya hay dos o más enlaces VIVOS (sin firmar ni
--      anular) del mismo paciente y documento (plantilla en CONSENT, plan en
--      BUDGET), se ANULAN los más antiguos —sin borrar nada— con el mismo
--      criterio que la API al reenviar: `revokedAt` = ahora y `revokedById` =
--      quien envió el más reciente (que es el que los reemplaza). Se anula su
--      código y su sesión, como `revoke`. Sigue vivo el más reciente. El
--      recuento sale como NOTICE. La DECISIÓN es anular y no fallar: dejar dos
--      enlaces vivos es justo el defecto que se corrige, el paciente solo
--      puede firmar con el que ya recibió en último lugar y el borrado no
--      existe (la evidencia queda). Los índices únicos parciales van en las
--      dos migraciones siguientes (CONCURRENTLY, una sentencia por fichero).
--   2. `signature_requests_counters_monotonic` (trigger): `failedAttempts` y
--      `codeSendCount` solo suben; un UPDATE que los baje falla, también para
--      un superusuario (un bloqueo por intentos no se «deshace» con SQL).
--   3. `signature_requests_evidence_clock` (trigger BEFORE INSERT/UPDATE): las
--      horas de la evidencia —apertura, envío del código, verificación,
--      bloqueo y firma— y `createdAt` (la hora del envío, que sella
--      `remoteSentAt`) las pone la BD con `now()` (inicio de la transacción) en el
--      momento en que pasan de NULL a un valor (el envío del código, cada vez
--      que cambia). Lo que mande la app (`dentalix_app`) se ignora; un
--      superusuario (solo local y CI; el owner de producción no lo es, así que
--      recibe las de la BD) conserva las suyas. La API lee esa hora de la
--      BD antes de decidir (`withLockedRequest`) para que los hashes que
--      sellan el consentimiento y la aceptación lleven la misma hora.
--   4. CHECK `signature_requests_signed_before_expiry_check`: `signedAt` no
--      puede ser posterior a `expiresAt` (la hora de la BD frente a la
--      caducidad que fijó el reloj de la app). Nace NOT VALID (no recorre la
--      tabla; solo comprueba filas nuevas o cambiadas) y se valida en la migración
--      siguiente, que no bloquea lecturas ni escrituras.
--   5. REVOKE DELETE a `dentalix_app` (DB-065): la app ya no tenía ningún
--      camino de borrado (el trigger `signature_requests_no_delete` lo
--      impedía y `guardHardDeletes` quita `delete` del cliente de tenant); ahora
--      tampoco tiene el privilegio (create-app-role.sql lo repite y
--      `db:check-force` lo vigila). Hoy nadie borra en producción: el trigger
--      solo deja a un superusuario y el owner no lo es; una purga futura
--      (DX-039) tendrá que correr con un rol que pueda.
--
-- Compatible hacia atrás: el código anterior no hace nada que el trigger o el
-- CHECK rechacen (nunca baja un contador, las horas que manda se sustituyen por
-- las de la BD y no firma tras caducar: `isLinkUsable`).
--
-- Bloqueo: ACCESS EXCLUSIVE sobre signature_requests desde el principio y sin
-- subir de bloqueo después (patrón DX-316): lo piden el NO FORCE/FORCE de la
-- RLS y el ADD CONSTRAINT, y tomarlo al inicio evita el interbloqueo con una
-- transacción de la app que ya leyó la tabla y quiere escribir. Se mantiene
-- hasta el COMMIT (dedupe + triggers + CHECK NOT VALID: la tabla es pequeña,
-- una fila por envío; el CHECK no recorre la tabla). lock_timeout evita quedar
-- encolado detrás de una transacción larga: si salta, se reintenta.
--
-- RLS: signature_requests está en FORCE. En producción el owner no es
-- superusuario ni BYPASSRLS (job «Migraciones con owner sin superusuario»):
-- con row_security = off y FORCE, la deduplicación FALLARÍA aun con la tabla
-- vacía. Por eso NO FORCE durante la deduplicación y FORCE otra vez antes del
-- COMMIT (DX-113/DX-134/DX-316).

SET LOCAL lock_timeout = '5s';
-- Con row_security = off, una consulta a la que se aplicaría una política
-- FALLA en vez de filtrar en silencio (ver 20261015130000); junto con el NO
-- FORCE de abajo, o se ven todas las filas o la migración se detiene.
SET LOCAL row_security = off;

LOCK TABLE "signature_requests" IN ACCESS EXCLUSIVE MODE;
ALTER TABLE "signature_requests" NO FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 1. Duplicados vivos -> anular los más antiguos (sin borrar).
-- ---------------------------------------------------------------------------
-- BEGIN dedupe
DO $dedupe$
DECLARE
  revoked bigint;
BEGIN
  WITH live AS (
    SELECT sr."id",
           row_number() OVER w AS rn,
           first_value(sr."createdById") OVER w AS keeper_by
      FROM "signature_requests" sr
     WHERE sr."signedAt" IS NULL AND sr."revokedAt" IS NULL
    WINDOW w AS (
      PARTITION BY sr."tenantId", sr."patientId", sr."type",
        CASE WHEN sr."type" = 'BUDGET' THEN sr."treatmentPlanId" ELSE sr."templateId" END
      ORDER BY sr."createdAt" DESC, sr."id" DESC
    )
  )
  UPDATE "signature_requests" t
     SET "revokedAt" = (pg_catalog.now() AT TIME ZONE 'UTC'),
         "revokedById" = live.keeper_by,
         "codeHash" = NULL,
         "codeExpiresAt" = NULL,
         "sessionHash" = NULL,
         "sessionExpiresAt" = NULL,
         "updatedAt" = (pg_catalog.now() AT TIME ZONE 'UTC')
    FROM live
   WHERE t."id" = live."id" AND live.rn > 1;
  GET DIAGNOSTICS revoked = ROW_COUNT;
  RAISE NOTICE 'DX-425: % enlace(s) vivo(s) duplicado(s) anulado(s) (queda el más reciente de cada documento)', revoked;
END
$dedupe$;
-- END dedupe

-- ---------------------------------------------------------------------------
-- 2. Los contadores solo suben.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public."signature_requests_counters_monotonic"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."failedAttempts" < OLD."failedAttempts"
     OR NEW."codeSendCount" < OLD."codeSendCount" THEN
    RAISE EXCEPTION 'signature_requests: los intentos fallidos y los códigos enviados solo suben, no pueden bajar (DX-425)'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "signature_requests_counters_monotonic"
  BEFORE UPDATE ON "signature_requests"
  FOR EACH ROW EXECUTE FUNCTION public."signature_requests_counters_monotonic"();

-- ---------------------------------------------------------------------------
-- 3. Las horas de la evidencia las pone la BD.
-- ---------------------------------------------------------------------------
-- Se llama «evidence_clock» para que dispare ANTES que
-- `signature_requests_guard` (los BEFORE van por orden alfabético): una hora ya
-- puesta no se toca aquí y el guard rechaza que la reescriban.
CREATE FUNCTION public."signature_requests_evidence_clock"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  -- Hora de inicio de la transacción, en UTC y a milisegundos: igual que las
  -- columnas TIMESTAMP(3) que escribe Prisma y que la hora que lee la API
  -- antes de decidir. La forma UTC de abajo es la que admite
  -- test/server-time-utc.int-spec.ts (DX-226); no escribas aquí comentarios
  -- con las funciones de hora: esa prueba mira el texto de la función.
  db_now timestamp(3) := (pg_catalog.now() AT TIME ZONE 'UTC');
BEGIN
  -- Un superusuario (local, CI, semillas y pruebas que siembran historia)
  -- conserva las horas que escribe, igual que la purga de
  -- dx_forbid_clinical_record_mutation; la app (dentalix_app) y el owner de
  -- producción (sin superusuario) reciben las de la BD.
  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  ) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    NEW."createdAt" := db_now;
    IF NEW."openedAt" IS NOT NULL THEN NEW."openedAt" := db_now; END IF;
    IF NEW."verifiedAt" IS NOT NULL THEN NEW."verifiedAt" := db_now; END IF;
    IF NEW."lockedAt" IS NOT NULL THEN NEW."lockedAt" := db_now; END IF;
    IF NEW."signedAt" IS NOT NULL THEN NEW."signedAt" := db_now; END IF;
    IF NEW."codeSentAt" IS NOT NULL THEN NEW."codeSentAt" := db_now; END IF;
    RETURN NEW;
  END IF;

  IF NEW."openedAt" IS NOT NULL AND OLD."openedAt" IS NULL THEN
    NEW."openedAt" := db_now;
  END IF;
  IF NEW."verifiedAt" IS NOT NULL AND OLD."verifiedAt" IS NULL THEN
    NEW."verifiedAt" := db_now;
  END IF;
  IF NEW."lockedAt" IS NOT NULL AND OLD."lockedAt" IS NULL THEN
    NEW."lockedAt" := db_now;
  END IF;
  IF NEW."signedAt" IS NOT NULL AND OLD."signedAt" IS NULL THEN
    NEW."signedAt" := db_now;
  END IF;
  -- El envío del código se repite (reenvíos): cada cambio es un envío nuevo.
  IF NEW."codeSentAt" IS NOT NULL
     AND NEW."codeSentAt" IS DISTINCT FROM OLD."codeSentAt" THEN
    NEW."codeSentAt" := db_now;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "signature_requests_evidence_clock"
  BEFORE INSERT OR UPDATE ON "signature_requests"
  FOR EACH ROW EXECUTE FUNCTION public."signature_requests_evidence_clock"();

-- ---------------------------------------------------------------------------
-- 4. No se firma después de caducar (se valida en la migración siguiente).
-- ---------------------------------------------------------------------------
ALTER TABLE "signature_requests"
  ADD CONSTRAINT "signature_requests_signed_before_expiry_check"
  CHECK ("signedAt" IS NULL OR "signedAt" <= "expiresAt") NOT VALID;

-- ---------------------------------------------------------------------------
-- 5. La app no borra solicitudes de firma.
-- ---------------------------------------------------------------------------
REVOKE DELETE ON "signature_requests" FROM dentalix_app;

-- Vuelve el FORCE (antes del COMMIT, ver arriba).
ALTER TABLE "signature_requests" FORCE ROW LEVEL SECURITY;
