-- DX-446: huecos reservados para urgencias (porción 1).
--
-- Cambios (todos ADITIVOS, con valores por defecto que no cambian nada de lo
-- que ya existe):
--   appointment_types.isUrgent          boolean NOT NULL DEFAULT false: el
--                                       tipo es de urgencia (se ofrece primero
--                                       al reservar huecos).
--   schedule_blocks.reservedForTypeIds  uuid[] NOT NULL DEFAULT '{}': tipos de
--                                       cita que SÍ pueden agendarse en un
--                                       bloque RESERVED.
--   schedule_blocks.releaseAtMinute     int NULL: «Liberar a partir de», hora
--                                       de PARED de la sede en minutos desde
--                                       las 00:00 del día del bloque (0..1439),
--                                       como los tramos del horario
--                                       (location_business_hours.startMinute).
--                                       Pasada esa hora (reloj del servidor en
--                                       la zona de la sede) el hueco admite
--                                       cualquier tipo.
--
-- CHECKs:
--   RESERVED exige ≥1 tipo, sede y no deja agendar libremente
--   (allowsBooking = false); los demás tipos no llevan tipos ni liberación.
--
-- Tenant: los tipos referenciados tienen que ser de la MISMA clínica que el
-- bloque. Un uuid[] no admite FK, así que lo garantiza un trigger (la API lo
-- valida antes con 404/400). Solo se mira al insertar o al cambiar la lista:
-- retirar después un tipo no rompe el bloque.
--
-- Sin índice nuevo: la agenda sigue filtrando por (tenantId, locationId, end)
-- y (tenantId, providerId, end); el tipo se resuelve en memoria sobre los
-- pocos bloques del rango.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "appointment_types"
  ADD COLUMN "isUrgent" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "schedule_blocks"
  ADD COLUMN "reservedForTypeIds" UUID[] NOT NULL DEFAULT '{}',
  ADD COLUMN "releaseAtMinute" INTEGER;

ALTER TABLE "schedule_blocks"
  ADD CONSTRAINT "schedule_blocks_reserved_check" CHECK (
    CASE
      WHEN "kind" = 'RESERVED' THEN
        cardinality("reservedForTypeIds") BETWEEN 1 AND 20
        AND array_position("reservedForTypeIds", NULL) IS NULL
        AND "locationId" IS NOT NULL
        AND "allowsBooking" = false
      ELSE
        cardinality("reservedForTypeIds") = 0
        AND "releaseAtMinute" IS NULL
    END
  ),
  ADD CONSTRAINT "schedule_blocks_release_minute_check" CHECK (
    "releaseAtMinute" IS NULL OR "releaseAtMinute" BETWEEN 0 AND 1439
  );

-- Los tipos reservados son de la clínica del bloque (no hay FK para uuid[]).
CREATE OR REPLACE FUNCTION schedule_blocks_reserved_types_same_tenant()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  wanted integer;
  found integer;
BEGIN
  IF cardinality(NEW."reservedForTypeIds") = 0 THEN
    RETURN NEW;
  END IF;
  SELECT count(DISTINCT t) INTO wanted FROM unnest(NEW."reservedForTypeIds") AS t;
  SELECT count(*) INTO found
    FROM "appointment_types" at
   WHERE at."tenantId" = NEW."tenantId"
     AND at."id" = ANY (NEW."reservedForTypeIds");
  IF found <> wanted THEN
    RAISE EXCEPTION 'schedule_blocks.reservedForTypeIds: tipo de cita de otra clínica o inexistente'
      USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "schedule_blocks_reserved_types_tenant"
  BEFORE INSERT OR UPDATE OF "reservedForTypeIds", "tenantId" ON "schedule_blocks"
  FOR EACH ROW EXECUTE FUNCTION schedule_blocks_reserved_types_same_tenant();
