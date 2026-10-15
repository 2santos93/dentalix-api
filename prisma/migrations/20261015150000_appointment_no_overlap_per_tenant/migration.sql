-- DX-036 / DB-003: las EXCLUDE anti-solape de citas pasan a ser POR CLINICA.
--
-- Las constraints de Postgres se evaluan SALTANDO la RLS (igual que las FK de
-- SEC-004). `appointments_no_overlap_per_provider` no incluia "tenantId" y
-- "providerId" es un `users.id` global: un profesional con membresia en dos
-- clinicas recibia en la clinica B un 409 por una cita que solo existe en la
-- clinica A. Eso revelaba la ocupacion de A (canal lateral) y dejaba a B
-- bloquear la agenda de A con citas propias que A no puede ver.
--
-- Decision: el solape se impide DENTRO de la misma clinica (en cualquiera de
-- sus sedes: la constraint no incluye "locationId", como hasta ahora). Entre
-- clinicas distintas queda permitido: cada clinica gestiona su agenda y
-- Dentalix no debe filtrar datos de otro tenant. Bloquear el solape fisico
-- entre clinicas, si producto lo quisiera, exigiria una decision explicita con
-- un mensaje que no revele nada, no un efecto colateral de la constraint.
--
-- `appointments_no_overlap_per_patient` recibe el mismo cambio por coherencia:
-- "patientId" ya es del tenant por la FK compuesta (tenantId, patientId), asi
-- que ahi no habia fuga, pero ambas siguen ahora la misma regla.
--
-- Se CONSERVAN los nombres: el mapeo 23P01 -> 409 del codigo
-- (src/modules/appointments/application/appointment-overlap-error.ts) los
-- reconoce por nombre y no cambia. Se conserva tambien el resto de la
-- definicion: tsrange (start/end son timestamp SIN zona), rango medio-abierto
-- [start, end) y el WHERE parcial (vivas y no canceladas), espejo de los
-- pre-checks findOverlapping / findOverlappingForPatient.
--
-- Seguro sobre datos existentes: la nueva constraint es estrictamente MAS LAXA
-- (anade una columna con `=`), asi que toda fila que cumplia la antigua cumple
-- la nueva; no hay pre-flight que pueda fallar ni filas que se modifiquen.
-- Idempotente: solo se reemplaza una constraint que todavia no tiene
-- "tenantId". DROP + ADD van en el mismo bloque DO (una sola sentencia,
-- atomica): la tabla nunca queda sin proteccion para otra transaccion.
-- Bloqueo: ADD CONSTRAINT ... EXCLUDE reconstruye el indice GiST con
-- ACCESS EXCLUSIVE sobre "appointments" mientras dura (una tabla por clinica
-- de tamano modesto; aceptable en la ventana de despliegue).

CREATE EXTENSION IF NOT EXISTS btree_gist;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_no_overlap_per_provider'
      AND conrelid = '"appointments"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%"tenantId" WITH =%'
  ) THEN
    ALTER TABLE "appointments"
      DROP CONSTRAINT IF EXISTS "appointments_no_overlap_per_provider";
    ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_no_overlap_per_provider"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        "providerId" WITH =,
        tsrange("start", "end") WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "status" <> 'CANCELLED');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_no_overlap_per_patient'
      AND conrelid = '"appointments"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%"tenantId" WITH =%'
  ) THEN
    ALTER TABLE "appointments"
      DROP CONSTRAINT IF EXISTS "appointments_no_overlap_per_patient";
    ALTER TABLE "appointments"
      ADD CONSTRAINT "appointments_no_overlap_per_patient"
      EXCLUDE USING gist (
        "tenantId" WITH =,
        "patientId" WITH =,
        tsrange("start", "end") WITH &&
      )
      WHERE ("deletedAt" IS NULL AND "status" <> 'CANCELLED');
  END IF;
END
$$;

-- Restricciones NO gestionadas por Prisma (a proposito, como las originales):
-- schema.prisma no puede modelar EXCLUDE constraints, asi que no hay drift.
-- Grants/RLS: sin cambios.
