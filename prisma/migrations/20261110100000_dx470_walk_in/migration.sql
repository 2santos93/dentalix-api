-- DX-470: «Atender sin cita» (urgencia en un paso, porción 2 de DX-446).
--
-- Cambios (todos ADITIVOS, con valores por defecto que no cambian nada de lo
-- que ya existe):
--   TriageFlag                       enum de las 6 señales de triaje de
--                                    recepción (dolor, inflamación, infección,
--                                    fiebre, sangrado, traumatismo).
--   appointments."triageFlags"       "TriageFlag"[] NOT NULL DEFAULT '{}'.
--   appointments."triageNote"        varchar(200) NULL: nota de triaje.
--   appointments."walkIn"            boolean NOT NULL DEFAULT false: la cita
--                                    nació en «Atender sin cita».
--   appointments."overbooked"        boolean NOT NULL DEFAULT false: sobrecupo
--                                    anotado (sin hueco reservado libre). Solo
--                                    en una cita sin cita previa.
--   ReservedOverrideKind             RESERVED_SLOT (DX-446) | WALK_IN_OVERBOOK.
--   appointment_reserved_overrides."kind"  NOT NULL DEFAULT 'RESERVED_SLOT':
--                                    el motivo del sobrecupo reutiliza la
--                                    tabla del «Agendar igualmente» de
--                                    DX-446 (texto fuera de audit_event). Un
--                                    sobrecupo no salta ningún bloque, así
--                                    que su lista de bloques puede ir vacía.
--
-- EXCLUDE: un sobrecupo, por definición, se solapa con la agenda del
-- profesional, así que `appointments_no_overlap_per_provider` deja de
-- contarlo (WHERE ... AND NOT "overbooked"). La constraint es estrictamente
-- MÁS LAXA (toda fila que cumplía la antigua cumple la nueva): no hay
-- pre-flight que pueda fallar. DROP + ADD en el mismo bloque DO (una sola
-- sentencia, atómica), como 20261015150000. El solape del PACIENTE no cambia.
-- Bloqueo: ADD ... EXCLUDE reconstruye el índice GiST con ACCESS EXCLUSIVE
-- sobre "appointments" mientras dura (la misma ventana que 20261015150000).
--
-- CHECKs NOT VALID (bloqueo de milisegundos); la migración siguiente los
-- valida. La de bloques del override se sustituye por una más laxa (antes
-- exigía ≥ 1 bloque siempre; ahora solo en RESERVED_SLOT).
--
-- Sin índice nuevo: el panel «En clínica» sigue en
-- appointments_tenant_location_in_clinic_idx; no hay filtro nuevo.
--
-- RLS/FORCE: sin cambios (columnas de tablas que ya la tienen). Las señales y
-- la nota son datos de salud: la API solo las devuelve en GET
-- /appointments/:id y en el panel «En clínica» (personal de la sede), nunca
-- en vistas públicas, recordatorios ni logs.
--
-- Compatible hacia atrás: el código anterior no lee las columnas nuevas, y
-- sus INSERT toman los valores por defecto (sin sobrecupo, RESERVED_SLOT).

SET LOCAL lock_timeout = '5s';

CREATE TYPE "TriageFlag" AS ENUM (
  'PAIN', 'SWELLING', 'INFECTION', 'FEVER', 'BLEEDING', 'TRAUMA'
);

CREATE TYPE "ReservedOverrideKind" AS ENUM ('RESERVED_SLOT', 'WALK_IN_OVERBOOK');

ALTER TABLE "appointments"
  ADD COLUMN "triageFlags" "TriageFlag"[] NOT NULL DEFAULT '{}',
  ADD COLUMN "triageNote" VARCHAR(200),
  ADD COLUMN "walkIn" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "overbooked" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_triage_check" CHECK (
    cardinality("triageFlags") <= 6
    AND array_position("triageFlags", NULL) IS NULL
    AND ("triageNote" IS NULL OR (
      "triageNote" = btrim("triageNote")
      AND char_length("triageNote") BETWEEN 1 AND 200
    ))
  ) NOT VALID,
  ADD CONSTRAINT "appointments_overbooked_walk_in_check" CHECK (
    NOT "overbooked" OR "walkIn"
  ) NOT VALID;

ALTER TABLE "appointment_reserved_overrides"
  ADD COLUMN "kind" "ReservedOverrideKind" NOT NULL DEFAULT 'RESERVED_SLOT';

ALTER TABLE "appointment_reserved_overrides"
  DROP CONSTRAINT "appointment_reserved_overrides_blocks_check",
  ADD CONSTRAINT "appointment_reserved_overrides_blocks_check" CHECK (
    cardinality("blockIds") BETWEEN
      CASE WHEN "kind" = 'RESERVED_SLOT' THEN 1 ELSE 0 END AND 20
    AND array_position("blockIds", NULL) IS NULL
  ) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'appointments_no_overlap_per_provider'
      AND conrelid = '"appointments"'::regclass
      AND pg_get_constraintdef(oid) LIKE '%overbooked%'
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
      WHERE ("deletedAt" IS NULL AND "status" <> 'CANCELLED' AND NOT "overbooked");
  END IF;
END
$$;
