-- DX-569: guardas de integridad de los enlaces de pago y de los reportes
-- del paciente (molde de DX-443, signed_consent_pdf_links_guard).
--
--   payment_links    nunca cambian el destino, el paciente, la sede, lo
--                    pedido, el token, la caducidad ni quién y cuándo lo
--                    creó. Mientras está vivo solo cambian: usedAt y
--                    revokedAt (de NULL a valor, una vez), openedAt (de NULL
--                    a valor), el contador de subidas autorizadas (solo
--                    hacia arriba) y el comprobante preparado. Usado o
--                    anulado, ya no cambia NADA: el reporte se crea en otra
--                    tabla y el archivado solo anula los vivos.
--   payment_reports  lo que reportó el paciente es inmutable. El estado
--                    solo pasa de PENDING a CONFIRMED o REJECTED, una vez,
--                    con su abono o su motivo y quién y cuándo decidió (las
--                    correcciones de recepción van solo en el abono). Un
--                    reporte decidido ya no cambia.
--
-- DELETE y TRUNCATE prohibidos en las dos (son el rastro de lo que se pidió
-- y se reportó); como en DX-443, solo el superusuario (la limpieza de los
-- tests) puede borrar. SECURITY INVOKER y search_path fijado; sin consultas
-- a otras tablas (solo OLD/NEW y el catálogo de roles al borrar).
--
-- Tablas nuevas (DX-569, 20261224090300) que el código anterior no conoce.
-- Vuelta atrás: DROP TRIGGER … y DROP FUNCTION de las dos guardas.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public."payment_links_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'payment_links: no se borra un enlace de pago (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."usedAt" IS NOT NULL OR OLD."revokedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_links: un enlace usado o anulado no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."treatmentPlanId" IS DISTINCT FROM OLD."treatmentPlanId"
     OR NEW."openingBalanceId" IS DISTINCT FROM OLD."openingBalanceId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."concept" IS DISTINCT FROM OLD."concept"
     OR NEW."tokenHash" IS DISTINCT FROM OLD."tokenHash"
     OR NEW."expiresAt" IS DISTINCT FROM OLD."expiresAt"
     OR NEW."channel" IS DISTINCT FROM OLD."channel"
     OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment_links: lo que pide el enlace no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- La apertura solo se marca una vez (OLD no estaba usado ni anulado, así
  -- que usedAt y revokedAt pasan, como mucho, de NULL a valor).
  IF OLD."openedAt" IS NOT NULL
     AND NEW."openedAt" IS DISTINCT FROM OLD."openedAt" THEN
    RAISE EXCEPTION 'payment_links: la apertura no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."proofUploadsIssued" < OLD."proofUploadsIssued" THEN
    RAISE EXCEPTION 'payment_links: las subidas autorizadas no se devuelven (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_links_guard"
  BEFORE UPDATE OR DELETE ON "payment_links"
  FOR EACH ROW EXECUTE FUNCTION public."payment_links_guard"();
CREATE TRIGGER "payment_links_no_truncate"
  BEFORE TRUNCATE ON "payment_links"
  FOR EACH STATEMENT EXECUTE FUNCTION public."payment_links_guard"();

CREATE FUNCTION public."payment_reports_guard"() RETURNS trigger
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
    RAISE EXCEPTION 'payment_reports: no se borra un reporte de pago (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION 'payment_reports: un reporte decidido no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."status" NOT IN ('CONFIRMED', 'REJECTED') THEN
    RAISE EXCEPTION 'payment_reports: un reporte pendiente solo se confirma o se rechaza (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."linkId" IS DISTINCT FROM OLD."linkId"
     OR NEW."patientId" IS DISTINCT FROM OLD."patientId"
     OR NEW."locationId" IS DISTINCT FROM OLD."locationId"
     OR NEW."paymentMethodId" IS DISTINCT FROM OLD."paymentMethodId"
     OR NEW."amount" IS DISTINCT FROM OLD."amount"
     OR NEW."currency" IS DISTINCT FROM OLD."currency"
     OR NEW."reference" IS DISTINCT FROM OLD."reference"
     OR NEW."paidOn" IS DISTINCT FROM OLD."paidOn"
     OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."proofUploadId" IS DISTINCT FROM OLD."proofUploadId"
     OR NEW."proofKey" IS DISTINCT FROM OLD."proofKey"
     OR NEW."proofMime" IS DISTINCT FROM OLD."proofMime"
     OR NEW."proofSize" IS DISTINCT FROM OLD."proofSize"
     OR NEW."proofSha256" IS DISTINCT FROM OLD."proofSha256"
     OR NEW."proofName" IS DISTINCT FROM OLD."proofName"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION 'payment_reports: lo que reportó el paciente no cambia (DX-569)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- El resto (abono, motivo, quién y cuándo) lo exige completo y coherente
  -- con el estado el CHECK payment_reports_status_check.
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_reports_guard"
  BEFORE UPDATE OR DELETE ON "payment_reports"
  FOR EACH ROW EXECUTE FUNCTION public."payment_reports_guard"();
CREATE TRIGGER "payment_reports_no_truncate"
  BEFORE TRUNCATE ON "payment_reports"
  FOR EACH STATEMENT EXECUTE FUNCTION public."payment_reports_guard"();
