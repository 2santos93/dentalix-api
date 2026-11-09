-- DX-379 (porción C): aceptar un presupuesto VENCIDO. La aceptación firmada en
-- la clínica guarda cómo se aceptó (fuera del contenido firmado y de sus
-- hashes, como `clinicLogoKey` de DX-019-bis):
--
--   treatment_plan_acceptances."quoteValidUntil"  DATE NULL   copia del último
--                                                             día válido del
--                                                             presupuesto del
--                                                             plan al firmar
--                                                             (antes de
--                                                             recotizar)
--   treatment_plan_acceptances."expiredMode"      enum NULL   REPRICE (se
--                                                             actualizaron los
--                                                             precios antes de
--                                                             firmar) u
--                                                             ORIGINAL_PRICES
--                                                             (se aceptó con
--                                                             los precios del
--                                                             presupuesto
--                                                             vencido)
--   treatment_plan_acceptances."expiredReason"    enum NULL   motivo de
--                                                             ORIGINAL_PRICES
--   treatment_plan_acceptances."expiredNote"      TEXT NULL   nota (1..200),
--                                                             obligatoria con
--                                                             OTHER
--   treatment_plan_acceptances."repricingId"      UUID NULL   la recotización
--                                                             (source ACCEPT)
--                                                             hecha en la firma
--
-- NULL en todas = no estaba vencido (o aceptación anterior a esta porción):
-- sin relleno. Las columnas se escriben en el INSERT de la aceptación; el
-- trigger `treatment_plan_acceptances_immutable` ya rechaza todo UPDATE, así
-- que nacen inmutables sin tocarlo.
--
-- FK COMPUESTA (SEC-004) de la recotización: de la MISMA clínica, del MISMO
-- plan y del MISMO paciente. Pide un índice único en
-- treatment_plan_repricings ("tenantId", "id", "planId", "patientId"): la
-- tabla es de DX-379 (B), reciente y pequeña; el CREATE UNIQUE INDEX bloquea
-- sus escrituras lo que tarda (no CONCURRENTLY: va en la transacción de la
-- migración).
--
-- Índice parcial del lado hijo de la FK (solo las aceptaciones con
-- recotización): el RI check del VALIDATE y de un ON DELETE RESTRICT no
-- recorren la tabla. Se crea vacío de entradas (todas las filas tienen
-- `repricingId` NULL), pero CREATE INDEX lee la tabla una vez con SHARE (no
-- bloquea lecturas; las firmas esperan lo que tarde).
--
-- CHECK y FK NOT VALID aquí (las filas existentes tienen todo a NULL) y
-- VALIDATE aparte (20261206090100_dx379c_expired_quote_acceptance_validate),
-- como DX-019-bis y la porción A: el ACCESS EXCLUSIVE dura lo que el ALTER.
-- Expand puro: columnas NULL sin default (PG 16 solo toca el catálogo). Una
-- réplica anterior inserta sin nombrar las columnas y recibe NULL, que cumple
-- los CHECK. Sin fechas con hora: sin trigger UTC. Las columnas heredan el
-- grant de la tabla a dentalix_app y su RLS.
--
-- Vuelta atrás (solo si hay que retirar esta porción):
--   1. Primero se despliega la versión anterior de la API (no lee ni escribe
--      estas columnas).
--   2. Después, en una transacción con el mismo lock_timeout:
--        ALTER TABLE "treatment_plan_acceptances"
--          DROP CONSTRAINT "treatment_plan_acceptances_repricing_fkey",
--          DROP CONSTRAINT "treatment_plan_acceptances_expired_check",
--          DROP CONSTRAINT "treatment_plan_acceptances_expired_note_check",
--          DROP COLUMN "repricingId", DROP COLUMN "expiredNote",
--          DROP COLUMN "expiredReason", DROP COLUMN "expiredMode",
--          DROP COLUMN "quoteValidUntil";
--        DROP INDEX "treatment_plan_acceptances_repricing_idx";
--        DROP INDEX "treatment_plan_repricings_tenant_id_plan_patient_key";
--        DROP TYPE "ExpiredQuoteAcceptanceReason";
--        DROP TYPE "ExpiredQuoteAcceptanceMode";
--      y se borran de `_prisma_migrations` las filas de esta migración y de
--      su VALIDATE (`npx prisma migrate resolve --rolled-back <nombre>`).
--   Se PIERDE cómo se aceptó cada presupuesto vencido (modo, motivo, nota y
--   enlace a la recotización); la recotización en sí sigue en
--   treatment_plan_repricings (source ACCEPT) y el contenido firmado no cambia.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "ExpiredQuoteAcceptanceMode" AS ENUM ('REPRICE', 'ORIGINAL_PRICES');

CREATE TYPE "ExpiredQuoteAcceptanceReason" AS ENUM (
  'CLINIC_DELAY',
  'PRICE_COMMITMENT',
  'LOYALTY',
  'FINANCIAL_HARDSHIP',
  'OTHER'
);

-- Lado referenciado de la FK compuesta.
CREATE UNIQUE INDEX "treatment_plan_repricings_tenant_id_plan_patient_key"
  ON "treatment_plan_repricings"("tenantId", "id", "planId", "patientId");

ALTER TABLE "treatment_plan_acceptances"
  ADD COLUMN "quoteValidUntil" DATE,
  ADD COLUMN "expiredMode" "ExpiredQuoteAcceptanceMode",
  ADD COLUMN "expiredReason" "ExpiredQuoteAcceptanceReason",
  ADD COLUMN "expiredNote" TEXT,
  ADD COLUMN "repricingId" UUID,
  -- Sin modo, nada más; con modo, la validez copiada. ORIGINAL_PRICES lleva
  -- motivo y no recotización; REPRICE lleva la recotización y ni motivo ni
  -- nota.
  ADD CONSTRAINT "treatment_plan_acceptances_expired_check" CHECK (
    (
      "expiredMode" IS NULL
      AND "expiredReason" IS NULL
      AND "expiredNote" IS NULL
      AND "repricingId" IS NULL
    )
    OR (
      "expiredMode" = 'ORIGINAL_PRICES'
      AND "quoteValidUntil" IS NOT NULL
      AND "expiredReason" IS NOT NULL
      AND "repricingId" IS NULL
    )
    OR (
      "expiredMode" = 'REPRICE'
      AND "quoteValidUntil" IS NOT NULL
      AND "repricingId" IS NOT NULL
      AND "expiredReason" IS NULL
      AND "expiredNote" IS NULL
    )
  ) NOT VALID,
  -- La nota, de 1 a 200 caracteres sin espacios alrededor; obligatoria con
  -- OTHER (como la del descuento).
  ADD CONSTRAINT "treatment_plan_acceptances_expired_note_check" CHECK (
    (
      "expiredNote" IS NULL
      OR (
        "expiredNote" = btrim("expiredNote")
        AND char_length("expiredNote") BETWEEN 1 AND 200
      )
    )
    AND ("expiredReason" IS DISTINCT FROM 'OTHER' OR "expiredNote" IS NOT NULL)
  ) NOT VALID,
  ADD CONSTRAINT "treatment_plan_acceptances_repricing_fkey"
    FOREIGN KEY ("tenantId", "repricingId", "planId", "patientId")
    REFERENCES "treatment_plan_repricings"("tenantId", "id", "planId", "patientId")
    ON DELETE RESTRICT ON UPDATE CASCADE
    NOT VALID;

CREATE INDEX "treatment_plan_acceptances_repricing_idx"
  ON "treatment_plan_acceptances"("tenantId", "repricingId")
  WHERE "repricingId" IS NOT NULL;
