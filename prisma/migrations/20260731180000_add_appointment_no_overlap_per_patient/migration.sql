-- Doble-agendado del PACIENTE imposible a nivel de DB. Hasta ahora solo existía
-- la constraint por profesional (appointments_no_overlap_per_provider), asi que
-- un mismo paciente podia quedar con dos citas simultaneas con dos odontologos
-- distintos: fisicamente imposible (no puede estar en dos sillones). Cierra
-- ademas la carrera check-then-insert del pre-check
-- `findOverlappingForPatient` (dos escrituras concurrentes pueden pasar ambas el
-- pre-check y colisionar solo al escribir).

-- btree_gist ya lo habilito 20260731161000_add_appointment_no_overlap_exclusion;
-- se repite el CREATE EXTENSION por idempotencia (no falla si ya esta).
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Mismas decisiones que la constraint por profesional (ver esa migracion para el
-- detalle):
--  * `tsrange` y NO `tstzrange`: "start"/"end" son `timestamp(3)` SIN zona, y
--    `tstzrange(timestamp)` no es IMMUTABLE -> Postgres lo rechaza en un indice.
--  * "end" es palabra reservada -> siempre citada.
--  * Rango medio-abierto [start, end): dos citas contiguas NO se solapan, igual
--    que la logica de findOverlappingForPatient.
--  * WHERE parcial espejo del pre-check: solo filas vivas y no canceladas, asi
--    una cita CANCELLED o soft-deleted nunca bloquea el horario del paciente.
-- Guard idempotente: no falla si la constraint ya existe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap_per_patient'
  ) THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_no_overlap_per_patient"
      EXCLUDE USING gist (
        "patientId" WITH =,
        tsrange("start", "end") WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "status" <> 'CANCELLED');
  END IF;
END
$$;

-- Restriccion NO gestionada por Prisma (a proposito): schema.prisma no puede
-- modelar una EXCLUDE constraint, asi que vive solo en SQL crudo. Prisma no
-- introspecta exclusion constraints -> no hay drift ni reset en
-- `migrate deploy`. Grants/RLS: sin cambios (rol owner "dentalix"; la EXCLUDE
-- constraint es ortogonal a la RLS de "appointments").
--
-- Pre-flight verificado antes de aplicar: 0 pares de citas activas y no
-- canceladas del mismo paciente con horarios solapados en la DB compartida.
