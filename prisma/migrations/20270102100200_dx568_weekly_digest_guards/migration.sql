-- DX-568: guardas de integridad del envío semanal y de sus entregas (molde
-- de DX-569 / DX-443, payment_links_guard y signed_consent_pdf_links_guard).
--
--   weekly_digest_runs        la clínica, la semana, la foto de la cartera y
--                             la fecha de alta no cambian nunca. El estado
--                             solo pasa de SENDING a SENT o SKIPPED, una vez,
--                             junto con completedAt (de NULL a valor) y los
--                             recuentos. Cerrado, el envío ya no cambia NADA.
--   weekly_digest_deliveries  la clínica, el envío, la membresía, el hash del
--                             token, la caducidad y la fecha de alta no
--                             cambian. usedAt y emailOutboxId solo pasan de
--                             NULL a un valor. Usada (usedAt no NULL), la
--                             entrega ya no cambia NADA.
--
-- DELETE y TRUNCATE prohibidos en las dos (son el rastro de lo que se envió
-- y de la baja); como en DX-443/DX-569, solo el superusuario (la limpieza de
-- los tests) puede borrar. SECURITY INVOKER y search_path fijado; sin
-- consultas a otras tablas (solo OLD/NEW y el catálogo de roles al borrar).
--
-- Va en una migración propia: 20270102100100 ya estaba aplicada. Tablas
-- nuevas de DX-568 que el código anterior no conoce.
-- Vuelta atrás: DROP TRIGGER … y DROP FUNCTION de las dos guardas.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public."weekly_digest_runs_guard"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'weekly_digest_runs: no se borra un envío semanal (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'SENDING' THEN
    RAISE EXCEPTION 'weekly_digest_runs: un envío cerrado no cambia (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."weekStart" IS DISTINCT FROM OLD."weekStart"
     OR NEW."receivablesSnapshot" IS DISTINCT FROM OLD."receivablesSnapshot"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'weekly_digest_runs: la clínica, la semana y la foto del envío no cambian (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- OLD está en SENDING: solo se cierra (SENT o SKIPPED) con su fecha y sus
  -- recuentos, todo a la vez.
  IF NEW."status" NOT IN ('SENT', 'SKIPPED') OR NEW."completedAt" IS NULL THEN
    RAISE EXCEPTION 'weekly_digest_runs: un envío solo pasa de SENDING a SENT o SKIPPED con su fecha (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "weekly_digest_runs_guard"
  BEFORE UPDATE OR DELETE ON "weekly_digest_runs"
  FOR EACH ROW EXECUTE FUNCTION public."weekly_digest_runs_guard"();
CREATE TRIGGER "weekly_digest_runs_no_truncate"
  BEFORE TRUNCATE ON "weekly_digest_runs"
  FOR EACH STATEMENT EXECUTE FUNCTION public."weekly_digest_runs_guard"();

CREATE FUNCTION public."weekly_digest_deliveries_guard"() RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    IF EXISTS (
      SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
    ) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION 'weekly_digest_deliveries: no se borra una entrega del resumen (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."usedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'weekly_digest_deliveries: una entrega usada no cambia (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."runId" IS DISTINCT FROM OLD."runId"
     OR NEW."membershipId" IS DISTINCT FROM OLD."membershipId"
     OR NEW."unsubscribeTokenHash" IS DISTINCT FROM OLD."unsubscribeTokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'weekly_digest_deliveries: el destinatario, el token y la caducidad no cambian (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."emailOutboxId" IS NOT NULL
     AND NEW."emailOutboxId" IS DISTINCT FROM OLD."emailOutboxId" THEN
    RAISE EXCEPTION 'weekly_digest_deliveries: el email encolado no cambia (DX-568)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "weekly_digest_deliveries_guard"
  BEFORE UPDATE OR DELETE ON "weekly_digest_deliveries"
  FOR EACH ROW EXECUTE FUNCTION public."weekly_digest_deliveries_guard"();
CREATE TRIGGER "weekly_digest_deliveries_no_truncate"
  BEFORE TRUNCATE ON "weekly_digest_deliveries"
  FOR EACH STATEMENT EXECUTE FUNCTION public."weekly_digest_deliveries_guard"();
