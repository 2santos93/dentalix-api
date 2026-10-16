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
-- Zona de la sede: la de su horario vivo; sin horario, la de su país (ES →
-- Europe/Madrid, CO → America/Bogota), igual que `loadLocationTimeZones`.
-- Idempotente: tras correr, ninguna fila afectada sigue a medianoche UTC.
-- "updatedAt" no cambia (lo mantiene la app, no la BD).
--
-- row_security = off: con RLS FORCE el owner vería 0 filas y el UPDATE no haría
-- nada en silencio (ver 20261016130000_domain_checks). lock_timeout: si una
-- transacción larga retiene "payments", falla limpia y se reintenta el deploy.

SET LOCAL row_security = off;
SET LOCAL lock_timeout = '10s';

UPDATE "payments" AS p
   SET "paidAt" = (
         ((p."paidAt"::date + TIME '12:00')
           AT TIME ZONE COALESCE(
             s."timezone",
             CASE l."country" WHEN 'ES' THEN 'Europe/Madrid' ELSE 'America/Bogota' END
           ))
         AT TIME ZONE 'UTC'
       )
  FROM "locations" AS l
  LEFT JOIN "location_schedules" AS s
    ON s."tenantId" = l."tenantId"
   AND s."locationId" = l."id"
   AND s."deletedAt" IS NULL
 WHERE l."tenantId" = p."tenantId"
   AND l."id" = p."locationId"
   AND p."paidAt" = date_trunc('day', p."paidAt");
