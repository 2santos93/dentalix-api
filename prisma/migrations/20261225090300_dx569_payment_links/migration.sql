-- DX-569: el paciente reporta su pago por enlace.
--
--   payment_method_instructions  datos para pagar de un medio: de toda la
--                                clínica ("locationId" NULL) o de una sede,
--                                que gana a la de la clínica. Campos neutros
--                                y opcionales, al menos uno con texto. Uno
--                                por (clínica, medio, sede), NULLS NOT
--                                DISTINCT (PG ≥ 15).
--   PaymentReportStatus          enum nuevo: PENDING, CONFIRMED, REJECTED.
--   payment_links                enlace de pago de UN destino (plan o saldo
--                                migrado, exactamente uno) con la foto de lo
--                                pedido. Solo el hash del token. Un enlace
--                                vivo (sin usar ni anular) por paciente y
--                                destino: índice único parcial. Hasta 3
--                                subidas de comprobante autorizadas.
--   payment_reports              el reporte del paciente: uno por enlace.
--                                CONFIRMED lleva el abono que creó (único);
--                                REJECTED, el motivo interno.
--
-- Solo AÑADE (un enum y tres tablas vacías): el código anterior no las
-- conoce. Las FK COMPUESTAS por clínica (SEC-004) van dentro del CREATE TABLE:
-- las tablas nacen vacías, así que no hay nada que validar con FORCE (DX-134)
-- y las tablas referenciadas solo toman un candado breve. RLS FORCE por
-- clínica con la política tenant_isolation, como patient_majority_reviews.
--
-- La app inserta, lee y actualiza las tres. Solo borra filas de
-- payment_method_instructions (configuración sin datos de pacientes: quitar
-- los datos de una sede vuelve a los de la clínica; queda en audit_events);
-- los enlaces y los reportes son evidencia y nunca se borran.
--
-- Vuelta atrás: desplegar la API anterior y
--   DROP TABLE public."payment_reports";
--   DROP TABLE public."payment_links";
--   DROP TABLE public."payment_method_instructions";
--   DROP TYPE public."PaymentReportStatus";
-- (se pierden los enlaces, los reportes y los datos para pagar).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Datos para pagar
-- ---------------------------------------------------------------------------

CREATE TABLE "payment_method_instructions" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "paymentMethodId" UUID NOT NULL,
    "locationId" UUID,
    "holderName" TEXT,
    "holderId" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "phone" TEXT,
    "email" TEXT,
    "note" TEXT,
    "createdById" UUID NOT NULL,
    "updatedById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_method_instructions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_method_instructions_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_method_instructions_method_fkey"
      FOREIGN KEY ("tenantId", "paymentMethodId") REFERENCES "payment_methods"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- MATCH SIMPLE: sin sede (toda la clínica) no se comprueba.
    CONSTRAINT "payment_method_instructions_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Los topes de la API. Un campo en blanco se guarda como NULL: nunca un
    -- texto vacío ni con blancos en los extremos.
    CONSTRAINT "payment_method_instructions_fields_check" CHECK (
      ("holderName" IS NULL OR ("holderName" = btrim("holderName") AND char_length("holderName") BETWEEN 1 AND 80))
      AND ("holderId" IS NULL OR ("holderId" = btrim("holderId") AND char_length("holderId") BETWEEN 1 AND 30))
      AND ("bankName" IS NULL OR ("bankName" = btrim("bankName") AND char_length("bankName") BETWEEN 1 AND 80))
      AND ("accountNumber" IS NULL OR ("accountNumber" = btrim("accountNumber") AND char_length("accountNumber") BETWEEN 1 AND 40))
      AND ("phone" IS NULL OR ("phone" = btrim("phone") AND char_length("phone") BETWEEN 1 AND 20))
      AND ("email" IS NULL OR ("email" = btrim("email") AND char_length("email") BETWEEN 1 AND 120))
      AND ("note" IS NULL OR ("note" = btrim("note") AND char_length("note") BETWEEN 1 AND 280))
    ),
    CONSTRAINT "payment_method_instructions_not_empty_check" CHECK (
      num_nonnulls("holderName", "holderId", "bankName", "accountNumber",
                   "phone", "email", "note") >= 1
    )
);

-- Una fila por medio y sede (NULL = toda la clínica cuenta como un valor).
CREATE UNIQUE INDEX "payment_method_instructions_scope_key"
  ON "payment_method_instructions"("tenantId", "paymentMethodId", "locationId")
  NULLS NOT DISTINCT;

-- Lado hijo de la FK de la sede.
CREATE INDEX "payment_method_instructions_location_idx"
  ON "payment_method_instructions"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- Enlaces de pago
-- ---------------------------------------------------------------------------

CREATE TYPE "PaymentReportStatus" AS ENUM ('PENDING', 'CONFIRMED', 'REJECTED');

CREATE TABLE "payment_links" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "treatmentPlanId" UUID,
    "openingBalanceId" UUID,
    "locationId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "concept" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "channel" TEXT,
    "createdById" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedAt" TIMESTAMP(3),
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "proofUploadsIssued" INTEGER NOT NULL DEFAULT 0,
    "stagedProofUploadId" UUID,
    "stagedProofKey" TEXT,
    "stagedProofMime" TEXT,
    "stagedProofSize" INTEGER,
    "stagedProofSha256" TEXT,
    "stagedProofName" TEXT,

    CONSTRAINT "payment_links_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_links_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_links_patient_fkey"
      FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El destino es del MISMO paciente y clínica (MATCH SIMPLE: el que no
    -- se usa va a NULL y no se comprueba).
    CONSTRAINT "payment_links_plan_fkey"
      FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId")
      REFERENCES "treatment_plans"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_links_opening_balance_fkey"
      FOREIGN KEY ("tenantId", "openingBalanceId", "patientId")
      REFERENCES "opening_balances"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_links_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_links_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    -- Como payments_target_check: un plan O un saldo migrado.
    CONSTRAINT "payment_links_target_check" CHECK (
      num_nonnulls("treatmentPlanId", "openingBalanceId") = 1
    ),
    CONSTRAINT "payment_links_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "payment_links_concept_check" CHECK (
      "concept" IN ('INSTALLMENT', 'BALANCE')
    ),
    CONSTRAINT "payment_links_channel_check" CHECK (
      "channel" IS NULL OR "channel" IN ('EMAIL', 'WHATSAPP')
    ),
    -- SHA-256 en hex: nunca el token en claro.
    CONSTRAINT "payment_links_token_hash_check" CHECK (
      "tokenHash" ~ '^[0-9a-f]{64}$'
    ),
    CONSTRAINT "payment_links_expires_check" CHECK ("expiresAt" > "createdAt"),
    -- Un enlace usado (con reporte) ya no se anula, y viceversa.
    CONSTRAINT "payment_links_used_revoked_check" CHECK (
      "usedAt" IS NULL OR "revokedAt" IS NULL
    ),
    CONSTRAINT "payment_links_proof_uploads_check" CHECK (
      "proofUploadsIssued" BETWEEN 0 AND 3
    ),
    -- El comprobante preparado va entero o no va (10 MB como el del abono).
    CONSTRAINT "payment_links_staged_proof_check" CHECK (
      num_nonnulls("stagedProofUploadId", "stagedProofKey", "stagedProofMime",
                   "stagedProofSize", "stagedProofSha256", "stagedProofName") IN (0, 6)
      AND ("stagedProofSize" IS NULL OR "stagedProofSize" BETWEEN 1 AND 10485760)
    )
);

CREATE UNIQUE INDEX "payment_links_token_hash_key" ON "payment_links"("tokenHash");

-- Destino de la FK compuesta de payment_reports.
CREATE UNIQUE INDEX "payment_links_tenant_id_patient_key"
  ON "payment_links"("tenantId", "id", "patientId");

-- Un enlace vivo por paciente y destino: crear otro anula el anterior (y los
-- caducados sin anular) en la misma transacción.
CREATE UNIQUE INDEX "payment_links_live_key"
  ON "payment_links"("tenantId", "patientId", (COALESCE("treatmentPlanId", "openingBalanceId")))
  WHERE "usedAt" IS NULL AND "revokedAt" IS NULL;

-- Los enlaces del paciente (lista, recuento y anulación al archivar) y lado
-- hijo de la FK del paciente.
CREATE INDEX "payment_links_patient_idx"
  ON "payment_links"("tenantId", "patientId", "createdAt" DESC);

-- Lados hijo de las FK del destino (parciales: la mitad de las filas lo lleva).
CREATE INDEX "payment_links_plan_idx"
  ON "payment_links"("tenantId", "treatmentPlanId") WHERE "treatmentPlanId" IS NOT NULL;
CREATE INDEX "payment_links_opening_balance_idx"
  ON "payment_links"("tenantId", "openingBalanceId") WHERE "openingBalanceId" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Reportes del paciente
-- ---------------------------------------------------------------------------

CREATE TABLE "payment_reports" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "linkId" UUID NOT NULL,
    "patientId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "paymentMethodId" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL,
    "reference" TEXT,
    "paidOn" DATE NOT NULL,
    "note" TEXT,
    "proofUploadId" UUID,
    "proofKey" TEXT,
    "proofMime" TEXT,
    "proofSize" INTEGER,
    "proofSha256" TEXT,
    "proofName" TEXT,
    "status" "PaymentReportStatus" NOT NULL DEFAULT 'PENDING',
    "paymentId" UUID,
    "rejectReason" TEXT,
    "decidedById" UUID,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_reports_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "payment_reports_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- El enlace del MISMO paciente y clínica (y, por él, el paciente).
    CONSTRAINT "payment_reports_link_fkey"
      FOREIGN KEY ("tenantId", "linkId", "patientId")
      REFERENCES "payment_links"("tenantId", "id", "patientId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_reports_location_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_reports_method_fkey"
      FOREIGN KEY ("tenantId", "paymentMethodId") REFERENCES "payment_methods"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_reports_payment_fkey"
      FOREIGN KEY ("tenantId", "paymentId") REFERENCES "payments"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_reports_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "payment_reports_amount_check" CHECK ("amount" > 0),
    CONSTRAINT "payment_reports_reference_check" CHECK (
      "reference" IS NULL
      OR ("reference" = btrim("reference") AND char_length("reference") BETWEEN 1 AND 60)
    ),
    CONSTRAINT "payment_reports_note_check" CHECK (
      "note" IS NULL
      OR ("note" = btrim("note") AND char_length("note") BETWEEN 1 AND 280)
    ),
    CONSTRAINT "payment_reports_proof_check" CHECK (
      num_nonnulls("proofUploadId", "proofKey", "proofMime", "proofSize",
                   "proofSha256", "proofName") IN (0, 6)
      AND ("proofSize" IS NULL OR "proofSize" BETWEEN 1 AND 10485760)
    ),
    -- Cada estado con lo suyo: el abono solo CONFIRMED, el motivo solo
    -- REJECTED, y quién y cuándo decidió en los dos.
    CONSTRAINT "payment_reports_status_check" CHECK (
      ("status" = 'PENDING'
        AND "paymentId" IS NULL AND "rejectReason" IS NULL
        AND "decidedById" IS NULL AND "decidedAt" IS NULL)
      OR ("status" = 'CONFIRMED'
        AND "paymentId" IS NOT NULL AND "rejectReason" IS NULL
        AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
      OR ("status" = 'REJECTED'
        AND "paymentId" IS NULL
        AND "rejectReason" IS NOT NULL
        AND "rejectReason" = btrim("rejectReason")
        AND char_length("rejectReason") BETWEEN 1 AND 280
        AND "decidedById" IS NOT NULL AND "decidedAt" IS NOT NULL)
    )
);

-- Un reporte por enlace (y destino de la relación de Prisma).
CREATE UNIQUE INDEX "payment_reports_link_key"
  ON "payment_reports"("tenantId", "linkId", "patientId");

-- Un abono confirma un solo reporte.
CREATE UNIQUE INDEX "payment_reports_payment_key"
  ON "payment_reports"("tenantId", "paymentId") WHERE "paymentId" IS NOT NULL;

-- La bandeja «Pagos por confirmar» y su recuento.
CREATE INDEX "payment_reports_inbox_idx"
  ON "payment_reports"("tenantId", "status", "createdAt");

-- Lados hijo de las FK del paciente (por el enlace), la sede y el medio.
CREATE INDEX "payment_reports_patient_idx"
  ON "payment_reports"("tenantId", "patientId");
CREATE INDEX "payment_reports_location_idx"
  ON "payment_reports"("tenantId", "locationId");
CREATE INDEX "payment_reports_method_idx"
  ON "payment_reports"("tenantId", "paymentMethodId");

-- ---------------------------------------------------------------------------
-- RLS y privilegios
-- ---------------------------------------------------------------------------

ALTER TABLE "payment_method_instructions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_method_instructions" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_method_instructions"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "payment_links" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_links" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_links"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "payment_reports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payment_reports" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "payment_reports"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "payment_method_instructions" TO dentalix_app;
REVOKE TRUNCATE ON "payment_method_instructions" FROM dentalix_app;

GRANT SELECT, INSERT, UPDATE ON "payment_links" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "payment_links" FROM dentalix_app;

GRANT SELECT, INSERT, UPDATE ON "payment_reports" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "payment_reports" FROM dentalix_app;
