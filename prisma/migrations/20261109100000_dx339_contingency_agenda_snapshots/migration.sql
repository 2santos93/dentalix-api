-- DX-339: agenda de contingencia por sede (citas de hoy y mañana en PDF para
-- trabajar en papel si cae la nube o internet).
--
-- Cambios:
--   contingency_agenda_snapshots   la ÚLTIMA copia nocturna de cada sede: una
--                                  fila por sede (se sobrescribe cada noche),
--                                  con la clave del PDF en el almacén, el día
--                                  civil que cubre («hoy» en la zona de la
--                                  sede al generarla), cuándo se generó, el nº
--                                  de citas y el tamaño. Sin datos del
--                                  paciente: el PDF vive en el almacén privado
--                                  y solo se sirve por la API (autenticada,
--                                  por rol y sede, y auditada).
--
-- Reglas en la BD:
--   * FK COMPUESTA por tenant a la sede (SEC-004) y FK a tenants. RESTRICT.
--   * Una fila por sede: PK ("tenantId", "locationId").
--   * Cifras no negativas; clave del almacén con el prefijo del espacio.
--   * RLS FORCE con NULLIF, como el resto de tablas de clínica.
--   * Sin DELETE para la app: la copia se sobrescribe, nunca se borra a mano.
--
-- Compatible hacia atrás: AÑADE una tabla vacía. El código anterior no la conoce.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "contingency_agenda_snapshots" (
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "forDate" DATE NOT NULL,
    "generatedAt" TIMESTAMPTZ(3) NOT NULL,
    "appointmentCount" INTEGER NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "storageKey" TEXT NOT NULL,
    "createdAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "contingency_agenda_snapshots_pkey" PRIMARY KEY ("tenantId", "locationId")
);

-- AddForeignKey
ALTER TABLE "contingency_agenda_snapshots" ADD CONSTRAINT "contingency_agenda_snapshots_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "contingency_agenda_snapshots" ADD CONSTRAINT "contingency_agenda_snapshots_location_fkey" FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- CHECKs
-- ---------------------------------------------------------------------------
ALTER TABLE "contingency_agenda_snapshots"
  ADD CONSTRAINT "contingency_agenda_snapshots_counts_check"
    CHECK ("appointmentCount" >= 0 AND "sizeBytes" > 0),
  ADD CONSTRAINT "contingency_agenda_snapshots_storage_key_check"
    CHECK ("storageKey" LIKE 'contingency-agendas/%' AND char_length("storageKey") <= 200);

-- ---------------------------------------------------------------------------
-- RLS FORCE
-- ---------------------------------------------------------------------------
ALTER TABLE "contingency_agenda_snapshots" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "contingency_agenda_snapshots"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "contingency_agenda_snapshots" FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants: los privilegios por defecto dan a dentalix_app SELECT, INSERT,
-- UPDATE y DELETE; aquí se recortan (sin DELETE ni TRUNCATE).
-- ---------------------------------------------------------------------------
REVOKE DELETE, TRUNCATE ON "contingency_agenda_snapshots" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "contingency_agenda_snapshots" TO dentalix_app;
