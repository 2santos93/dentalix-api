-- DX-427 (DB-064): la anestesia y la hoja de sedación son inalterables, pero
-- su dosis, su acumulado y su hora clínica solo los comprobaba la app. Un
-- INSERT por SQL (script, réplica antigua, error futuro del caso de uso)
-- podía dejar una dosis 0, negativa o absurda, un acumulado menor que la
-- propia dosis o una hora en el futuro, para siempre.
--
-- CHECK (NOT VALID aquí; VALIDATE en 20261107120100):
--   anesthesia_administrations_dose_range     0 < doseMg ≤ 10000 (el máximo
--       del dominio: 20 carpules × 5 ml × 10 % — CARPULES_MAX y los topes del
--       DTO del catálogo).
--   anesthesia_administrations_dose_derived   doseMg = carpules × ml ×
--       concentración × 10, redondeado a 0,1 como `lineMg` (± 0,1 por el
--       redondeo binario de la app). Los tres factores son la copia del
--       catálogo de la propia fila.
--   anesthesia_administrations_cumulative     el acumulado incluye la dosis
--       (cumulativeMg ≥ doseMg), el % no es negativo y la epinefrina
--       acumulada incluye la de la dosis (± 0,0001, `round4`).
--   *_not_future                              la hora clínica (administración,
--       valoración, checklist, toma, egreso) no pasa de la hora del registro
--       en el servidor (`createdAt`, que pone el trigger
--       dx_clinical_record_server_timestamp) más 15 min. La app ya rechaza
--       más de 5 min respecto a SU reloj; los 10 min extra toleran desfase
--       entre el reloj de la API y el de la base.
--
-- Guarda (trigger BEFORE INSERT, SQLSTATE propio Q4270 → 400 en la API):
--   la hora de la administración de anestesia, del fármaco de sedación y de
--   la toma de constantes no es anterior a la fecha de la evolución menos
--   36 h. `entryDate` es un día civil (medianoche UTC del día de la cita) o el
--   «ahora» de la evolución sin cita: 36 h cubren el día entero en cualquier
--   zona (UTC−12…UTC+14) y documentar al final de la jornada. Un CHECK no
--   puede leer otra tabla; el trigger es SECURITY INVOKER (lee la evolución
--   bajo la RLS de la sesión: sin `app.current_tenant` no la ve y deja pasar) y no se aplica a lo ya registrado.
--
-- Compatible hacia atrás: solo restringe lo que la app ya no escribe (sus
-- reglas son las mismas o más estrictas). Sin columnas, sin reescritura y sin
-- índices nuevos (ninguna consulta filtra por esto).
--
-- Bloqueo: ADD CONSTRAINT … NOT VALID y CREATE TRIGGER toman ACCESS EXCLUSIVE
-- / SHARE ROW EXCLUSIVE milisegundos (no recorren filas). El VALIDATE va en
-- la migración siguiente, en su propia transacción (SHARE UPDATE EXCLUSIVE:
-- no bloquea los registros nuevos). lock_timeout evita quedar encolado tras
-- una transacción larga.

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Anestesia
-- ---------------------------------------------------------------------------
ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_dose_range"
  CHECK ("doseMg" > 0 AND "doseMg" <= 10000) NOT VALID;

ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_dose_derived"
  CHECK (abs("doseMg" - round("carpules" * "mlPerCarpule" * "concentrationPct" * 10, 1)) <= 0.1) NOT VALID;

ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_cumulative"
  CHECK (
    "cumulativeMg" >= "doseMg"
    AND ("cumulativePercent" IS NULL OR "cumulativePercent" >= 0)
    AND ("cumulativeEpinephrineMg" IS NULL OR "epinephrineMg" IS NULL
         OR "cumulativeEpinephrineMg" + 0.0001 >= "epinephrineMg")
  ) NOT VALID;

ALTER TABLE "anesthesia_administrations" ADD CONSTRAINT "anesthesia_administrations_not_future"
  CHECK ("administeredAt" <= "createdAt" + interval '15 minutes') NOT VALID;

-- ---------------------------------------------------------------------------
-- 2. Hoja de sedación (la dosis del fármaco ya la acota
--    sedation_agent_administrations_kind_shape, DX-407)
-- ---------------------------------------------------------------------------
ALTER TABLE "sedation_records" ADD CONSTRAINT "sedation_records_not_future"
  CHECK ("assessedAt" IS NULL OR "assessedAt" <= "createdAt" + interval '15 minutes') NOT VALID;

ALTER TABLE "sedation_checklists" ADD CONSTRAINT "sedation_checklists_not_future"
  CHECK ("checkedAt" IS NULL OR "checkedAt" <= "createdAt" + interval '15 minutes') NOT VALID;

ALTER TABLE "sedation_agent_administrations" ADD CONSTRAINT "sedation_agent_administrations_not_future"
  CHECK ("administeredAt" <= "createdAt" + interval '15 minutes') NOT VALID;

ALTER TABLE "sedation_vitals" ADD CONSTRAINT "sedation_vitals_not_future"
  CHECK ("takenAt" <= "createdAt" + interval '15 minutes') NOT VALID;

ALTER TABLE "sedation_discharges" ADD CONSTRAINT "sedation_discharges_not_future"
  CHECK ("dischargedAt" <= "createdAt" + interval '15 minutes') NOT VALID;

-- ---------------------------------------------------------------------------
-- 3. No antes de la evolución (trigger: lee otra tabla)
-- ---------------------------------------------------------------------------
-- Mismo texto que BY_SQLSTATE.Q4270 de prisma-exception.filter.ts.
CREATE FUNCTION public.dx427_anesthesia_not_before_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  entry_date TIMESTAMP(3);
BEGIN
  SELECT e."entryDate" INTO entry_date
  FROM public."clinical_entries" e
  WHERE e."tenantId" = NEW."tenantId" AND e."id" = NEW."clinicalEntryId";
  IF entry_date IS NOT NULL
     AND NEW."administeredAt" < entry_date - interval '36 hours' THEN
    RAISE EXCEPTION 'La hora no puede ser anterior a la fecha de la evolución. Indica la fecha de atención correcta en la evolución.'
      USING ERRCODE = 'Q4270';
  END IF;
  RETURN NEW;
END;
$$;

-- TG_ARGV[0]: la columna de la hora clínica de la tabla hija de la hoja.
CREATE FUNCTION public.dx427_sedation_not_before_entry() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  entry_date TIMESTAMP(3);
  clinical_at TIMESTAMP(3);
BEGIN
  clinical_at := (to_jsonb(NEW) ->> TG_ARGV[0])::timestamp(3);
  SELECT e."entryDate" INTO entry_date
  FROM public."sedation_records" s
  JOIN public."clinical_entries" e
    ON e."tenantId" = s."tenantId" AND e."id" = s."clinicalEntryId"
  WHERE s."tenantId" = NEW."tenantId" AND s."id" = NEW."sedationRecordId";
  IF entry_date IS NOT NULL AND clinical_at < entry_date - interval '36 hours' THEN
    RAISE EXCEPTION 'La hora no puede ser anterior a la fecha de la evolución. Indica la fecha de atención correcta en la evolución.'
      USING ERRCODE = 'Q4270';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "anesthesia_administrations_not_before_entry"
  BEFORE INSERT ON "anesthesia_administrations"
  FOR EACH ROW EXECUTE FUNCTION public.dx427_anesthesia_not_before_entry();
CREATE TRIGGER "sedation_agent_administrations_not_before_entry"
  BEFORE INSERT ON "sedation_agent_administrations"
  FOR EACH ROW EXECUTE FUNCTION public.dx427_sedation_not_before_entry('administeredAt');
CREATE TRIGGER "sedation_vitals_not_before_entry"
  BEFORE INSERT ON "sedation_vitals"
  FOR EACH ROW EXECUTE FUNCTION public.dx427_sedation_not_before_entry('takenAt');
