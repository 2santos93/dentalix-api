-- DX-097: días civiles de caja y dashboard en la zona de la sede.
--
-- Hasta ahora el formulario de abono mandaba el DÍA elegido como medianoche UTC
-- (`new Date('2026-10-16')`) y la caja cortaba los días en UTC, así que ese
-- valor "funcionaba". Desde DX-097 la caja y el dashboard cortan el día a
-- medianoche de la zona de la sede (`location_schedules.timezone`): leída así,
-- una medianoche UTC es la tarde del día ANTERIOR en Bogotá (19:00).
--
-- Backfill (sin pérdida de datos, sin cambios de esquema): los abonos cuyo
-- "paidAt" es EXACTAMENTE medianoche UTC son días civiles del formulario; se
-- mueven al MEDIODÍA de ese mismo día en la zona de su sede, que es como la API
-- guarda desde ahora un abono registrado solo con fecha. Se conserva:
--   * el día civil en la zona de la sede (es el día que la clínica eligió);
--   * el día UTC (12:00 en Bogotá = 17:00 UTC, en Madrid = 10:00/11:00 UTC),
--     así que el código anterior —que lee el día UTC— y la tasa de cambio del
--     saldo del plan (por fecha UTC) siguen viendo el mismo día.
-- Un abono registrado por la API con hora (instante real) no es medianoche UTC
-- exacta salvo coincidencia al milisegundo; esos no se tocan.
--
-- Zona de la sede: la de su horario vivo SI Postgres la conoce
-- (pg_timezone_names); si no tiene horario o la zona no la conoce, la de su
-- país (ES → Europe/Madrid, CO → America/Bogota), igual que
-- `loadLocationTimeZones`. Una zona desconocida nunca aborta el despliegue.
--
-- Rastro y reversión: cada fila movida queda en
-- "payments_paidat_backfill_dx097" (abono, tenant, valor viejo y nuevo, zona
-- usada), rellenada en la MISMA sentencia con UPDATE ... RETURNING. Revertir:
--   UPDATE payments p SET "paidAt" = b.old_paid_at
--     FROM payments_paidat_backfill_dx097 b
--    WHERE b.payment_id = p.id AND p."paidAt" = b.new_paid_at;
-- La tabla es de operación, no de la app: RLS ENABLE + FORCE con política por
-- tenant (como el resto del esquema) y sin GRANT a "dentalix_app".
-- La API aplica la MISMA regla al escribir (RecordPaymentUseCase: una
-- medianoche UTC exacta es un día civil), así un cliente antiguo no vuelve a
-- guardar medianoches tras esta migración.
-- Idempotente: tras correr, ninguna fila afectada sigue a medianoche UTC.
-- "updatedAt" no cambia (lo mantiene la app, no la BD).
--
-- row_security = off: con RLS FORCE el owner vería 0 filas y el UPDATE no haría
-- nada en silencio (ver 20261016130000_domain_checks). lock_timeout: si una
-- transacción larga retiene "payments", falla limpia y se reintenta el deploy.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS "payments_paidat_backfill_dx097" (
    "payment_id"  UUID NOT NULL,
    "tenantId"    UUID NOT NULL,
    "old_paid_at" TIMESTAMP(3) NOT NULL,
    "new_paid_at" TIMESTAMP(3) NOT NULL,
    "time_zone"   TEXT NOT NULL,
    "migrated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT "payments_paidat_backfill_dx097_pkey" PRIMARY KEY ("payment_id")
);
ALTER TABLE "payments_paidat_backfill_dx097" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "payments_paidat_backfill_dx097" FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "tenant_isolation" ON "payments_paidat_backfill_dx097";
CREATE POLICY "tenant_isolation" ON "payments_paidat_backfill_dx097"
  USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
  WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);
REVOKE ALL ON "payments_paidat_backfill_dx097" FROM PUBLIC;
REVOKE ALL ON "payments_paidat_backfill_dx097" FROM "dentalix_app";

WITH zones AS (
  SELECT l."id" AS "locationId",
         l."tenantId",
         CASE
           WHEN s."timezone" IS NOT NULL
            AND s."timezone" IN (SELECT "name" FROM pg_timezone_names)
             THEN s."timezone"
           WHEN l."country" = 'ES' THEN 'Europe/Madrid'
           ELSE 'America/Bogota'
         END AS "zone"
    FROM "locations" AS l
    LEFT JOIN "location_schedules" AS s
      ON s."tenantId" = l."tenantId"
     AND s."locationId" = l."id"
     AND s."deletedAt" IS NULL
),
moved AS (
  UPDATE "payments" AS p
     SET "paidAt" = (((t."old_paid_at"::date + TIME '12:00') AT TIME ZONE t."zone") AT TIME ZONE 'UTC')
    FROM (
      SELECT p2."id", p2."paidAt" AS "old_paid_at", z."zone"
        FROM "payments" AS p2
        JOIN zones AS z
          ON z."tenantId" = p2."tenantId"
         AND z."locationId" = p2."locationId"
       WHERE p2."paidAt" = date_trunc('day', p2."paidAt")
         AND NOT EXISTS (
           SELECT 1 FROM "payments_paidat_backfill_dx097" AS b WHERE b."payment_id" = p2."id"
         )
    ) AS t
   WHERE p."id" = t."id"
  RETURNING p."id", p."tenantId", t."old_paid_at", p."paidAt" AS "new_paid_at", t."zone"
)
INSERT INTO "payments_paidat_backfill_dx097" ("payment_id", "tenantId", "old_paid_at", "new_paid_at", "time_zone")
SELECT "id", "tenantId", "old_paid_at", "new_paid_at", "zone" FROM moved;
