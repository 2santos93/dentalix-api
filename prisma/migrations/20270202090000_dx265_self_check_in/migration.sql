-- DX-265: «Ya llegué» del paciente, desde el enlace de su cita o con el QR
-- de la sede.
--
-- Cambios (todos ADITIVOS):
--   "AppointmentArrivalSource"   enum: PATIENT_LINK (el enlace firmado de la
--                                cita, DX-005) o SEDE_QR (el QR de la sede con
--                                documento y fecha de nacimiento).
--   appointments."arrivalSource" quién marcó la llegada si NO fue el personal.
--                                NULL = el personal (o una llegada anterior a
--                                DX-265). Solo con "arrivedAt" (CHECK
--                                appointments_arrival_source_check, NOT VALID;
--                                su VALIDATE va en 20270202090100).
--   location_check_in_settings   ajustes por sede: «Ya llegué» por enlace sí/no,
--                                ventana (minutos antes y después del inicio),
--                                umbral de retraso y el QR (SHA-256 del token;
--                                el token solo viaja en el cartel). Sin fila =
--                                valores por defecto y sin QR.
--   location_check_in_attempts   fallos de identificación con el QR por sede e
--                                IP (SHA-256 de sede + IP, nunca la IP): el
--                                quinto bloquea 15 minutos. Contador atómico
--                                (INSERT … ON CONFLICT DO UPDATE … RETURNING).
--   audit_events_actor_check     UNIÓN EXACTA del de main (20270115140200,
--                                DX-101-bis) y el UPDATE de APPOINTMENT sin
--                                usuario, origen PATIENT_LINK o SEDE_QR y
--                                reason PATIENT_SELF_CHECK_IN. NOT VALID; su
--                                VALIDATE va en 20270202090100.
--
-- Reglas en la BD (la API responde antes con 400/404/409 en español):
--   * FK directa a tenants ON DELETE RESTRICT y FK COMPUESTA (tenantId,
--     locationId) → locations (la sede es de la MISMA clínica), dentro del
--     CREATE TABLE (nacen vacías, DX-134). La de los intentos es CASCADE
--     (dato efímero derivado de la sede), como location_turn_counters.
--   * Rangos de la ventana y del umbral; el hash del QR y su fecha van juntos;
--     el hash del QR es único en TODA la BD (el host da el tenant, el token
--     la sede).
--   * RLS FORCE por tenant en las dos tablas, con NULLIF como el resto.
--   * Sin referencias a pacientes: nada que añadir a la fusión de pacientes
--     ni al deshacer de importaciones.
--
-- Bloqueo: tablas nuevas; en `appointments`, ADD COLUMN sin DEFAULT es solo
-- catálogo y el CHECK va NOT VALID. lock_timeout evita quedar encolado
-- detrás de una transacción larga.
--
-- Compatible hacia atrás: el código anterior no lee ni escribe la columna ni
-- las tablas; el CHECK de actor solo admite una escritura más.
--
-- Vuelta atrás: desplegar la API anterior y
--   ALTER TABLE "appointments" DROP CONSTRAINT "appointments_arrival_source_check",
--     DROP COLUMN "arrivalSource";
--   DROP TABLE "location_check_in_attempts", "location_check_in_settings";
--   DROP TYPE "AppointmentArrivalSource";
--   y restaurar el CHECK de actor de 20270115140200 (NOT VALID).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "AppointmentArrivalSource" AS ENUM ('PATIENT_LINK', 'SEDE_QR');

-- ---------------------------------------------------------------------------
-- 1. Origen de la llegada
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "arrivalSource" "AppointmentArrivalSource";
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_arrival_source_check"
  CHECK ("arrivalSource" IS NULL OR "arrivedAt" IS NOT NULL) NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Ajustes por sede
-- ---------------------------------------------------------------------------
CREATE TABLE "location_check_in_settings" (
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "linkEnabled" BOOLEAN NOT NULL DEFAULT true,
    "minutesBefore" INTEGER NOT NULL DEFAULT 30,
    "minutesAfter" INTEGER NOT NULL DEFAULT 30,
    "lateMinutes" INTEGER NOT NULL DEFAULT 10,
    "qrTokenHash" CHAR(64),
    "qrCreatedAt" TIMESTAMP(3),
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "location_check_in_settings_pkey" PRIMARY KEY ("tenantId", "locationId"),
    CONSTRAINT "location_check_in_settings_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica.
    CONSTRAINT "location_check_in_settings_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_check_in_settings_window_check" CHECK (
      "minutesBefore" BETWEEN 0 AND 240
      AND "minutesAfter" BETWEEN 0 AND 240
      AND "lateMinutes" BETWEEN 0 AND 240
    ),
    CONSTRAINT "location_check_in_settings_qr_check" CHECK (
      ("qrTokenHash" IS NULL) = ("qrCreatedAt" IS NULL)
      AND ("qrTokenHash" IS NULL OR "qrTokenHash" ~ '^[0-9a-f]{64}$')
    )
);

CREATE UNIQUE INDEX "location_check_in_settings_qr_token_hash_key"
  ON "location_check_in_settings"("qrTokenHash");

-- ---------------------------------------------------------------------------
-- 3. Fallos de identificación con el QR, por sede e IP
-- ---------------------------------------------------------------------------
CREATE TABLE "location_check_in_attempts" (
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "clientKey" CHAR(64) NOT NULL,
    "failedAttempts" INTEGER NOT NULL,
    "firstFailedAt" TIMESTAMP(3) NOT NULL,
    "lockedUntil" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_check_in_attempts_pkey" PRIMARY KEY ("tenantId", "locationId", "clientKey"),
    CONSTRAINT "location_check_in_attempts_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- CASCADE (no RESTRICT): dato efímero sin valor sin su sede, como
    -- location_turn_counters (DX-588).
    CONSTRAINT "location_check_in_attempts_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "location_check_in_attempts_client_key_check" CHECK ("clientKey" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "location_check_in_attempts_failed_check" CHECK ("failedAttempts" >= 0)
);

-- ---------------------------------------------------------------------------
-- 4. RLS y permisos
-- ---------------------------------------------------------------------------
ALTER TABLE "location_check_in_settings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_check_in_settings" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_check_in_settings"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "location_check_in_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_check_in_attempts" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_check_in_attempts"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Los ajustes no se borran (el QR se revoca poniendo el hash a NULL). Los
-- intentos son efímeros: un acierto borra la fila de su sede e IP.
GRANT SELECT, INSERT, UPDATE ON "location_check_in_settings" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "location_check_in_settings" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "location_check_in_attempts" TO dentalix_app;
REVOKE TRUNCATE ON "location_check_in_attempts" FROM dentalix_app;

-- ---------------------------------------------------------------------------
-- 5. CHECK de actor de audit_events
-- ---------------------------------------------------------------------------
ALTER TABLE "audit_events" DROP CONSTRAINT "audit_events_actor_check";
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_check"
  CHECK (
    "actorUserId" IS NOT NULL
    OR "action" = 'LOGIN_FAILED'
    -- IS TRUE: un CHECK que da NULL PASA.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PATIENT'
        AND "actorRole" IS NULL
        AND "resourceId" = "patientId"
        AND "metadata" ->> 'reason' = 'REMINDER_OPT_OUT'
        AND "metadata" ->> 'origin' IN ('LINK', 'MESSAGE')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT_PROMISE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' IN ('PROMISE_KEPT', 'PROMISE_BROKEN')) IS TRUE
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'MEDICAL_HISTORY_SUBMISSION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_SUBMITTED') IS TRUE
    OR ("action" = 'CREATE'
        AND "resourceType" = 'DATA_CONSENT'
        AND "actorRole" IS NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_LINK') IS TRUE
    -- DX-402: el barrido congeló una tasa de respaldo en un abono.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'PAYMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'EXCHANGE_RATE_BACKUP') IS TRUE
    -- DX-243: el paciente abre el enlace de firma, pide el código, lo
    -- verifica (o lo bloquea al fallar 5 veces) y firma.
    OR ("resourceType" = 'SIGNATURE_REQUEST'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'SIGNATURE_LINK_OPENED')
          OR ("action" = 'SEND' AND "metadata" ->> 'reason' = 'SIGNATURE_CODE_SENT')
          OR ("action" = 'UPDATE' AND "metadata" ->> 'reason' IN ('SIGNATURE_CODE_VERIFIED', 'SIGNATURE_LINK_LOCKED'))
          OR ("action" = 'SIGN' AND "metadata" ->> 'reason' = 'SIGNATURE_PATIENT_SIGNED'))) IS TRUE
    -- DX-361: el paciente confirma, cancela o pide que lo llamen desde el
    -- enlace de confirmación de la cita.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'LINK'
        AND "metadata" ->> 'reason' IN ('CONFIRMATION_LINK_CONFIRMED',
                                        'CONFIRMATION_LINK_CANCELLED',
                                        'CONFIRMATION_LINK_CALL_REQUESTED')) IS TRUE
    -- DX-422: el trabajo del PDF firmado encontró un consentimiento cuyo
    -- hash no casa con lo guardado (no se archiva nada). Solo ids.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'CONSENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'SIGNED_PDF_INTEGRITY_MISMATCH') IS TRUE
    -- DX-435: el paciente acepta o rechaza la oferta de hueco desde el
    -- enlace, el enlace caduca o el hueco se lo queda otro paciente.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'WAITLIST_OFFER'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('SLOT_OFFER_ACCEPTED',
                                        'SLOT_OFFER_DECLINED',
                                        'SLOT_OFFER_EXPIRED',
                                        'SLOT_OFFER_TAKEN_BY_OTHER')) IS TRUE
    -- DX-435: la cita que crea (CREATE) o adelanta (UPDATE) la aceptación
    -- desde el enlace, con el paciente de la cita.
    OR ("action" IN ('CREATE', 'UPDATE')
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'SLOT_OFFER_ACCEPTED') IS TRUE
    -- DX-443: el paciente (o su responsable) descarga su copia del PDF
    -- firmado desde el enlace de un solo uso del email. Solo ids.
    OR ("action" = 'EXPORT'
        AND "resourceType" = 'CONSENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'SIGNED_PDF_COPY_DOWNLOADED') IS TRUE
    -- DX-437: el paciente pide (o quita) «Avisarme si se libera un hueco
    -- antes» desde el enlace de confirmación de la cita.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('CONFIRMATION_LINK_EARLIER_REQUESTED',
                                        'CONFIRMATION_LINK_EARLIER_CLEARED')) IS TRUE
    -- DX-467: alguien sin sesión (una farmacia, el propio paciente) comprueba
    -- una receta por su código en la página pública: la consulta de una
    -- receta encontrada (válida o anulada) y la que encuentra el hash
    -- alterado. Solo ids y el motivo: el código no va en el evento.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'PRESCRIPTION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' IN ('PRESCRIPTION_VERIFIED',
                                        'PRESCRIPTION_INTEGRITY_MISMATCH')) IS TRUE
    -- DX-468: el paciente (o el responsable de un menor) abre la copia de su
    -- receta desde el enlace caducable que le envió la clínica. Solo ids y el
    -- motivo: el token no va en el evento.
    OR ("action" = 'VIEW'
        AND "resourceType" = 'PRESCRIPTION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'PRESCRIPTION_COPY_OPENED') IS TRUE
    -- DX-306: el paciente (o el responsable de un menor) abre la copia de su
    -- certificado (VIEW) o descarga su PDF (EXPORT) desde el enlace caducable
    -- que le envió la clínica por WhatsApp. Solo ids y el motivo.
    OR ("action" IN ('VIEW', 'EXPORT')
        AND "resourceType" = 'PATIENT_CERTIFICATE'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'CERTIFICATE_COPY_OPENED')
          OR ("action" = 'EXPORT' AND "metadata" ->> 'reason' = 'CERTIFICATE_COPY_DOWNLOADED'))) IS TRUE
    -- DX-569: el paciente (sin sesión) reporta su pago desde el enlace de
    -- pago: el alta del reporte. Solo ids y el motivo: ni importes ni la
    -- referencia van en el evento.
    OR ("action" = 'CREATE'
        AND "resourceType" = 'PAYMENT_REPORT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'PAYMENT_REPORT_SUBMITTED') IS TRUE
    -- DX-290: el recordatorio automático (trabajo de la cola, sin usuario)
    -- crea el enlace de anamnesis de un paciente nuevo o con la anamnesis
    -- caducada. Solo ids y el motivo: ni el token ni la URL van en el evento.
    OR ("action" = 'CREATE'
        AND "resourceType" = 'MEDICAL_HISTORY_SUBMISSION'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'ANAMNESIS_LINK_SENT_WITH_REMINDER') IS TRUE
    -- DX-572: el paciente (o el responsable de un menor) abre la copia de su
    -- orden de estudios o referencia (VIEW) o descarga su PDF y gasta el
    -- enlace de un solo uso (EXPORT). Solo ids y el motivo: ni el token, ni
    -- los estudios, ni la nota van en el evento.
    OR ("action" IN ('VIEW', 'EXPORT')
        AND "resourceType" = 'EXTERNAL_ORDER'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'EXTERNAL_ORDER_COPY_OPENED')
          OR ("action" = 'EXPORT' AND "metadata" ->> 'reason' = 'EXTERNAL_ORDER_COPY_DOWNLOADED'))) IS TRUE
    -- DX-561: el seguimiento automático de presupuestos (trabajo de la cola,
    -- sin usuario) envía al paciente un enlace de aceptación nuevo por opción.
    -- Solo ids, el paso y el motivo: ni el token, ni la URL, ni importes.
    OR ("action" = 'SEND'
        AND "resourceType" = 'SIGNATURE_REQUEST'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'QUOTE_FOLLOW_UP_SENT') IS TRUE
    -- DX-016: la página pública de reserva online (sin sesión): el código
    -- del email enviado, verificado o bloqueado; la solicitud o reserva
    -- creada; y, en la misma transacción, la ficha nueva del paciente, su
    -- consentimiento de datos y la cita. Solo ids y el motivo.
    OR ("actorRole" IS NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'ONLINE_BOOKING'
        AND (("resourceType" = 'ONLINE_BOOKING'
              AND "resourceId" IS NOT NULL
              AND (("action" = 'SEND' AND "metadata" ->> 'reason' = 'ONLINE_BOOKING_CODE_SENT')
                OR ("action" = 'UPDATE' AND "metadata" ->> 'reason' IN ('ONLINE_BOOKING_CODE_VERIFIED',
                                                                       'ONLINE_BOOKING_CODE_LOCKED'))
                OR ("action" = 'CREATE' AND "metadata" ->> 'reason' IN ('ONLINE_BOOKING_REQUESTED',
                                                                       'ONLINE_BOOKING_BOOKED'))))
          OR ("action" = 'CREATE'
              AND "resourceType" = 'PATIENT'
              AND "resourceId" = "patientId"
              AND "metadata" ->> 'reason' = 'ONLINE_BOOKING_PATIENT_CREATED')
          OR ("action" = 'CREATE'
              AND "resourceType" = 'DATA_CONSENT'
              AND "metadata" ->> 'reason' = 'ONLINE_BOOKING_CONSENT')
          OR ("action" = 'CREATE'
              AND "resourceType" = 'APPOINTMENT'
              AND "resourceId" IS NOT NULL
              AND "metadata" ->> 'reason' = 'ONLINE_BOOKING_BOOKED'))) IS TRUE
    -- DX-101: el paciente verifica el enlace de acceso (VIEW) o lo bloquea
    -- al quinto fallo (UPDATE). Solo ids, el motivo y el número de fallos.
    OR ("resourceType" = 'PATIENT_ACCESS_LINK'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND (("action" = 'VIEW' AND "metadata" ->> 'reason' = 'PATIENT_ACCESS_VERIFIED')
          OR ("action" = 'UPDATE' AND "metadata" ->> 'reason' = 'PATIENT_ACCESS_LOCKED'))) IS TRUE
    -- DX-556: la retención anonimiza un prospecto perdido (el trabajo
    -- programado, sin usuario). Solo el id y el motivo.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'LEAD'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NULL
        AND "metadata" ->> 'origin' = 'JOB'
        AND "metadata" ->> 'reason' = 'LEAD_ANONYMIZED') IS TRUE
    -- DX-101-bis: el paciente (o el responsable de un menor) acepta con su
    -- firma un presupuesto desde el portal (SIGN del plan). Solo ids y el
    -- motivo: ni la firma, ni importes, ni el enlace van en el evento.
    OR ("action" = 'SIGN'
        AND "resourceType" = 'TREATMENT_PLAN'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' = 'PUBLIC_LINK'
        AND "metadata" ->> 'reason' = 'PORTAL_QUOTE_ACCEPTED') IS TRUE
    -- DX-265: el paciente marca «Ya llegué» desde el enlace de su cita
    -- (PATIENT_LINK) o con el QR de la sede (SEDE_QR): la cita pasa a
    -- «Llegó». Solo ids, el motivo, el origen y el cambio de estado.
    OR ("action" = 'UPDATE'
        AND "resourceType" = 'APPOINTMENT'
        AND "actorRole" IS NULL
        AND "resourceId" IS NOT NULL
        AND "patientId" IS NOT NULL
        AND "metadata" ->> 'origin' IN ('PATIENT_LINK', 'SEDE_QR')
        AND "metadata" ->> 'reason' = 'PATIENT_SELF_CHECK_IN') IS TRUE
  ) NOT VALID;
