-- DX-446: motivo de «Agendar igualmente» en un hueco reservado.
--
-- Cambios:
--   appointment_reserved_overrides  una fila por cita agendada o movida a un
--                                   hueco RESERVED saltándose la reserva
--                                   (ADMIN u odontólogo): los bloques saltados
--                                   y el MOTIVO escrito (5–300). El texto libre
--                                   NO va a audit_event (política DX-009,
--                                   como el «Otro» de DX-439): la auditoría
--                                   solo lleva el id de esta fila y los
--                                   bloques.
--
-- Reglas en la BD:
--   * FK COMPUESTA por tenant (SEC-004): la cita es de la MISMA clínica y del
--     MISMO paciente. RESTRICT: no desaparece en cascada.
--   * Append-only (trigger + REVOKE): solo un superusuario borra (limpieza de
--     tests); "createdAt" lo pone la BD en UTC (función de DX-439).
--   * RLS FORCE con NULLIF, como el resto de tablas de clínica.
--
-- Compatible hacia atrás: AÑADE una tabla vacía que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "appointment_reserved_overrides" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "appointmentId" UUID NOT NULL,
    "blockIds" UUID[] NOT NULL,
    "reason" VARCHAR(300) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "appointment_reserved_overrides_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "appointment_reserved_overrides_tenant_id_key"
  ON "appointment_reserved_overrides"("tenantId", "id");
CREATE INDEX "appointment_reserved_overrides_tenant_appointment_idx"
  ON "appointment_reserved_overrides"("tenantId", "patientId", "appointmentId");
CREATE INDEX "appointment_reserved_overrides_created_by_idx"
  ON "appointment_reserved_overrides"("createdById");

ALTER TABLE "appointment_reserved_overrides"
  ADD CONSTRAINT "appointment_reserved_overrides_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "appointment_reserved_overrides_appointment_fkey"
    FOREIGN KEY ("tenantId", "patientId", "appointmentId")
    REFERENCES "appointments"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT "appointment_reserved_overrides_createdById_fkey"
    FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "appointment_reserved_overrides"
  ADD CONSTRAINT "appointment_reserved_overrides_blocks_check" CHECK (
    cardinality("blockIds") BETWEEN 1 AND 20
    AND array_position("blockIds", NULL) IS NULL
  ),
  ADD CONSTRAINT "appointment_reserved_overrides_reason_check" CHECK (
    "reason" = btrim("reason")
    AND char_length("reason") BETWEEN 5 AND 300
    AND "reason" !~ '[[:cntrl:]]'
  );

CREATE TRIGGER "appointment_reserved_overrides_server_created_at"
  BEFORE INSERT ON "appointment_reserved_overrides"
  FOR EACH ROW EXECUTE FUNCTION public.dx439_server_created_at();

CREATE FUNCTION public.appointment_reserved_overrides_append_only() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') AND public.dx_cash_is_superuser() THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% es un registro de auditoría: no admite % (DX-446)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER "appointment_reserved_overrides_append_only"
  BEFORE UPDATE OR DELETE ON "appointment_reserved_overrides"
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reserved_overrides_append_only();
CREATE TRIGGER "appointment_reserved_overrides_no_truncate"
  BEFORE TRUNCATE ON "appointment_reserved_overrides"
  FOR EACH STATEMENT EXECUTE FUNCTION public.appointment_reserved_overrides_append_only();

ALTER TABLE "appointment_reserved_overrides" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "appointment_reserved_overrides"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "appointment_reserved_overrides" FORCE ROW LEVEL SECURITY;

REVOKE UPDATE, DELETE, TRUNCATE ON "appointment_reserved_overrides" FROM dentalix_app;
GRANT SELECT, INSERT ON "appointment_reserved_overrides" TO dentalix_app;
