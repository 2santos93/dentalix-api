-- Doble-reserva imposible a nivel de DB: cierra la carrera check-then-insert
-- del pre-check `findOverlapping` (create/update-appointment.use-case). Dos
-- citas NO canceladas y NO borradas del MISMO profesional cuyos rangos
-- horarios se solapan no pueden coexistir jamas, ni bajo inserciones
-- concurrentes que ambas pasen el pre-check en la aplicacion.

-- btree_gist habilita el operador "=" sobre "providerId" (uuid) dentro de un
-- indice GiST, para combinarlo con el operador de solape "&&" del rango
-- temporal en una unica EXCLUDE constraint. Idempotente.
CREATE EXTENSION IF NOT EXISTS btree_gist;

-- IMPORTANTE - tipo de columna: "start"/"end" son `timestamp(3) WITHOUT time
-- zone` (Prisma `DateTime` sin @db.Timestamptz, ver 20260723160013_add_appointments).
-- Por eso se usa `tsrange` y NO `tstzrange`: `tstzrange(timestamp)` exige un
-- cast dependiente del TimeZone de sesion (NO IMMUTABLE) y Postgres lo rechaza
-- en una expresion de indice. "end" es palabra reservada -> siempre citada.
-- Rango medio-abierto [start, end): dos citas adyacentes (end de una == start
-- de la otra) NO se solapan, igual que la logica half-open de findOverlapping.
-- WHERE parcial: solo filas vivas y no canceladas (espejo exacto del filtro de
-- findOverlapping) -> una cita CANCELLED o soft-deleted nunca bloquea el horario.
-- Guard idempotente: no falla si la constraint ya existe.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'appointments_no_overlap_per_provider'
  ) THEN
    ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_no_overlap_per_provider"
      EXCLUDE USING gist (
        "providerId" WITH =,
        tsrange("start", "end") WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "status" <> 'CANCELLED');
  END IF;
END
$$;

-- Restriccion NO gestionada por Prisma (a proposito): schema.prisma no puede
-- modelar una EXCLUDE constraint, asi que vive solo en SQL crudo. Prisma no
-- introspecta ni representa exclusion constraints ni extensiones -> no hay
-- drift ni reset en `migrate deploy`. Grants/RLS: sin cambios (rol owner
-- "dentalix"; la EXCLUDE constraint es ortogonal a la RLS de "appointments").
