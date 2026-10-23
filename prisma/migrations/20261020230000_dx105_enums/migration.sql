-- DX-105: convenios y listas de precios (enums).
--
-- Cambios:
--   AgreementKind       enum nuevo: PERCENT_DISCOUNT (porcentaje, global o por
--                       categoría del catálogo) y PRICE_LIST (precios de una
--                       lista).
--   PriceSource         enum nuevo: de dónde salió el precio sellado en un ítem
--                       de plan (CATALOG, PRICE_LIST, AGREEMENT_PERCENT,
--                       AGREEMENT_PRICE_LIST).
--   AuditResourceType   AGREEMENT y PRICE_LIST (altas, cambios, retiros y
--                       asignaciones a pacientes).
--
-- Reglas en la BD: ninguna (solo tipos; las tablas van en migraciones
-- posteriores, y los índices parciales de auditoría en la última: Postgres no
-- deja usar un valor de enum nuevo en la misma transacción que lo crea).
--
-- Compatible hacia atrás: solo AÑADE tipos y valores que el código anterior no
-- usa. IF NOT EXISTS en los valores: idempotente.
--
-- Grants: no aplica (un tipo no necesita grants).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "AgreementKind" AS ENUM ('PERCENT_DISCOUNT', 'PRICE_LIST');
CREATE TYPE "PriceSource" AS ENUM ('CATALOG', 'PRICE_LIST', 'AGREEMENT_PERCENT', 'AGREEMENT_PRICE_LIST');

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'AGREEMENT';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'PRICE_LIST';
