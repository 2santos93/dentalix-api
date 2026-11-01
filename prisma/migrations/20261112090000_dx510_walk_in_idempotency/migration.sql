-- DX-510: «Atender sin cita» idempotente (POST /appointments/walk-in).
--
-- Mismo contrato que los abonos (DX-109), los gastos (DX-274) y el saldo a
-- favor (DX-253): la cabecera Idempotency-Key (UUID) y la huella de la
-- petición se guardan con la cita que crea; repetir la MISMA petición devuelve
-- esa cita (sin un segundo paciente ni una segunda cita) y otra distinta con
-- la misma clave es un 422. Caducidad: la de la política existente, es decir,
-- la clave vive con su fila (no hay TTL). Aislamiento: el único es PARCIAL
-- (solo filas con clave) y por clínica ("tenantId" va en él; las constraints
-- saltan la RLS).
--
-- Compatible hacia atrás y aditiva: dos columnas nulas sin DEFAULT (solo
-- catálogo) y un índice único nuevo. Ninguna fila existente tiene clave, así
-- que el índice no puede fallar. El código anterior no lee ni escribe estas
-- columnas.
--
-- Bloqueo: CREATE UNIQUE INDEX (no CONCURRENTLY: Prisma corre la migración en
-- una transacción) toma SHARE sobre "appointments" mientras recorre la tabla:
-- bloquea escrituras, no lecturas. Las filas no entran en el índice parcial
-- (todas tienen la clave NULL): en una base de 60 000 citas tarda del orden de
-- decenas de milisegundos, como la EXCLUDE por sillón de DX-211.
--
-- Vuelta atrás: DROP INDEX "appointments_tenant_idempotency_key"; ALTER TABLE
-- "appointments" DROP COLUMN "idempotencyKey", DROP COLUMN
-- "idempotencyFingerprint" (sin pérdida de citas).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "appointments"
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "idempotencyFingerprint" TEXT;

CREATE UNIQUE INDEX "appointments_tenant_idempotency_key"
  ON "appointments"("tenantId", "idempotencyKey")
  WHERE "idempotencyKey" IS NOT NULL;
