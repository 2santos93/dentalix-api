-- SEC-004: aislamiento por tenant de TODAS las FK entre tablas de dominio.
--
-- Las FK simples `x -> padre(id)` solo garantizan "el padre existe en ALGUN
-- tenant": Postgres chequea las FK saltando la RLS. Un INSERT con el tenantId
-- del contexto pasaba el WITH CHECK y tambien la FK aunque el padre fuera de
-- otra clinica (p.ej. una evolucion de la clinica A contra un paciente de B).
-- Mismo patron que 20260801190000_appointment_patient_tenant_fk: FK COMPUESTA
-- (tenantId, x) -> padre(tenantId, id), con un UNIQUE (tenantId, id) en el padre.
--
-- Pagos y planes de pago van un paso mas alla: (tenantId, treatmentPlanId,
-- patientId) -> treatment_plans(tenantId, id, patientId). Eso exige el tenant y
-- ademas que el `patientId` denormalizado sea el del plan; el paciente queda
-- en el tenant por transitividad (treatment_plans tiene su propia FK compuesta).
--
-- Compatible hacia atras: no cambia columnas ni datos, solo constraints. La
-- semantica de borrado se conserva (RESTRICT, ON UPDATE CASCADE: lo que ya
-- tenian). La app ya escribe siempre el tenant del contexto en hijo y padre,
-- asi que ninguna escritura valida cambia de resultado.
--
-- Grants/RLS: sin cambios. Corre con el rol owner "dentalix" (DIRECT_URL); una
-- FK no altera los privilegios DML de dentalix_app.
--
-- Transaccion y locks. Prisma ejecuta el script entero como UNA transaccion
-- (si algo falla, no queda nada a medias). Al principio se toman locks SHARE
-- ROW EXCLUSIVE sobre todas las tablas implicadas (hijas y padres, en un
-- orden fijo para no generar deadlocks). Ese modo deja LEER pero bloquea
-- INSERT/UPDATE/DELETE hasta el COMMIT, asi que nadie puede colar una fila
-- inconsistente entre la comprobacion previa y el ADD CONSTRAINT. Es el mismo
-- modo que ADD FOREIGN KEY toma de todas formas sobre hija y padre; aqui solo
-- se adelanta. Los CREATE UNIQUE INDEX (sin CONCURRENTLY, que no admite
-- transaccion) toman SHARE sobre los padres. Hoy las tablas son pequenas y
-- todo dura milisegundos.
--
-- Alternativa para tablas grandes: ADD CONSTRAINT ... NOT VALID (solo toma el
-- lock un instante y valida las filas NUEVAS) y, en una migracion posterior,
-- ALTER TABLE ... VALIDATE CONSTRAINT ..., que recorre las filas existentes con
-- un lock SHARE UPDATE EXCLUSIVE (no bloquea escrituras). Los UNIQUE de los
-- padres irian antes con CREATE UNIQUE INDEX CONCURRENTLY, en su propia
-- migracion, porque no puede correr dentro de una transaccion.

-- ---------------------------------------------------------------------------
-- 0. row_security = off (transaccion actual). Las tablas tienen RLS FORCE, que
--    tambien aplica al owner si no es superusuario ni BYPASSRLS: la comprobacion
--    previa contaria 0 filas en silencio y daria un falso "todo limpio". Con
--    row_security = off, cualquier consulta a la que se le aplicaria una
--    politica FALLA ("query would be affected by row-level security policy")
--    en vez de filtrar. O se ven todas las filas, o la migracion se detiene. Si
--    se detiene por esto, hay que correrla con un rol superusuario o BYPASSRLS.
--    (Las FK en si se validan saltando la RLS, asi que no dependen de esto.)
-- ---------------------------------------------------------------------------
SET LOCAL row_security = off;

-- ---------------------------------------------------------------------------
-- 0b. Locks (ver arriba). Padres primero, luego hijas.
-- ---------------------------------------------------------------------------
LOCK TABLE "patients", "locations", "treatment_plans", "payment_plans",
  "inventory_items", "location_schedules"
  IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "medical_history_versions", "clinical_entries", "tooth_records",
  "treatment_plan_items", "payments", "installments", "appointments",
  "inventory_movements", "location_schedule_ranges"
  IN SHARE ROW EXCLUSIVE MODE;

-- ---------------------------------------------------------------------------
-- 1. Pre-flight. Si hay filas cuyo padre no existe en el MISMO tenant (o cuyo
--    patientId no es el del plan), se aborta con un mensaje claro antes de
--    crear ningun indice ni FK. NUNCA se borran ni se reescriben datos: hay
--    que revisarlos a mano, `prisma migrate resolve --rolled-back` y reintentar.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  bad text := '';
  n bigint;
BEGIN
  SELECT count(*) INTO n FROM "medical_history_versions" c
   WHERE NOT EXISTS (SELECT 1 FROM "patients" p WHERE p."id" = c."patientId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  medical_history_versions.patientId: %s', n); END IF;

  SELECT count(*) INTO n FROM "clinical_entries" c
   WHERE NOT EXISTS (SELECT 1 FROM "patients" p WHERE p."id" = c."patientId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  clinical_entries.patientId: %s', n); END IF;

  SELECT count(*) INTO n FROM "tooth_records" c
   WHERE NOT EXISTS (SELECT 1 FROM "patients" p WHERE p."id" = c."patientId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  tooth_records.patientId: %s', n); END IF;

  SELECT count(*) INTO n FROM "treatment_plans" c
   WHERE NOT EXISTS (SELECT 1 FROM "patients" p WHERE p."id" = c."patientId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  treatment_plans.patientId: %s', n); END IF;

  SELECT count(*) INTO n FROM "treatment_plan_items" c
   WHERE NOT EXISTS (SELECT 1 FROM "treatment_plans" p WHERE p."id" = c."planId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  treatment_plan_items.planId: %s', n); END IF;

  SELECT count(*) INTO n FROM "payments" c
   WHERE NOT EXISTS (SELECT 1 FROM "treatment_plans" p WHERE p."id" = c."treatmentPlanId" AND p."tenantId" = c."tenantId" AND p."patientId" = c."patientId");
  IF n > 0 THEN bad := bad || format(E'\n  payments.(treatmentPlanId, patientId): %s', n); END IF;

  SELECT count(*) INTO n FROM "payment_plans" c
   WHERE NOT EXISTS (SELECT 1 FROM "treatment_plans" p WHERE p."id" = c."treatmentPlanId" AND p."tenantId" = c."tenantId" AND p."patientId" = c."patientId");
  IF n > 0 THEN bad := bad || format(E'\n  payment_plans.(treatmentPlanId, patientId): %s', n); END IF;

  SELECT count(*) INTO n FROM "installments" c
   WHERE NOT EXISTS (SELECT 1 FROM "payment_plans" p WHERE p."id" = c."paymentPlanId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  installments.paymentPlanId: %s', n); END IF;

  SELECT count(*) INTO n FROM "appointments" c
   WHERE NOT EXISTS (SELECT 1 FROM "locations" p WHERE p."id" = c."locationId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  appointments.locationId: %s', n); END IF;

  SELECT count(*) INTO n FROM "payments" c
   WHERE NOT EXISTS (SELECT 1 FROM "locations" p WHERE p."id" = c."locationId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  payments.locationId: %s', n); END IF;

  SELECT count(*) INTO n FROM "inventory_items" c
   WHERE NOT EXISTS (SELECT 1 FROM "locations" p WHERE p."id" = c."locationId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  inventory_items.locationId: %s', n); END IF;

  SELECT count(*) INTO n FROM "inventory_movements" c
   WHERE NOT EXISTS (SELECT 1 FROM "inventory_items" p WHERE p."id" = c."itemId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  inventory_movements.itemId: %s', n); END IF;

  SELECT count(*) INTO n FROM "inventory_movements" c
   WHERE NOT EXISTS (SELECT 1 FROM "locations" p WHERE p."id" = c."locationId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  inventory_movements.locationId: %s', n); END IF;

  SELECT count(*) INTO n FROM "location_schedule_ranges" c
   WHERE NOT EXISTS (SELECT 1 FROM "location_schedules" p WHERE p."id" = c."scheduleId" AND p."tenantId" = c."tenantId");
  IF n > 0 THEN bad := bad || format(E'\n  location_schedule_ranges.scheduleId: %s', n); END IF;

  IF bad <> '' THEN
    RAISE EXCEPTION 'SEC-004: hay filas que referencian un padre de OTRO tenant (o inexistente, o con un patientId distinto del de su plan). No se crean las FK compuestas ni se toca ningun dato. Filas por FK:%', bad
      USING HINT = 'Revisa y corrige esas filas a mano (tenantId de hijo y padre), marca la migracion con prisma migrate resolve --rolled-back 20261015130000_tenant_composite_fks y vuelve a ejecutar prisma migrate deploy.';
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2. UNIQUE en los padres: destino de las FK compuestas. `id` ya es PK, asi
--    que estos indices nunca rechazan una fila existente.
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX "treatment_plans_tenant_id_key" ON "treatment_plans"("tenantId", "id");
CREATE UNIQUE INDEX "treatment_plans_tenant_id_patient_key" ON "treatment_plans"("tenantId", "id", "patientId");
CREATE UNIQUE INDEX "payment_plans_tenant_id_key" ON "payment_plans"("tenantId", "id");
CREATE UNIQUE INDEX "locations_tenant_id_key" ON "locations"("tenantId", "id");
CREATE UNIQUE INDEX "inventory_items_tenant_id_key" ON "inventory_items"("tenantId", "id");
CREATE UNIQUE INDEX "location_schedules_tenant_id_key" ON "location_schedules"("tenantId", "id");
-- patients_tenant_id_key ya existe (20260801190000_appointment_patient_tenant_fk).

-- ---------------------------------------------------------------------------
-- 3. Cambiar cada FK simple por su version compuesta.
-- ---------------------------------------------------------------------------

-- Hijos de patients.
ALTER TABLE "medical_history_versions" DROP CONSTRAINT "medical_history_versions_patientId_fkey";
ALTER TABLE "medical_history_versions" ADD CONSTRAINT "medical_history_versions_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "clinical_entries" DROP CONSTRAINT "clinical_entries_patientId_fkey";
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tooth_records" DROP CONSTRAINT "tooth_records_patientId_fkey";
ALTER TABLE "tooth_records" ADD CONSTRAINT "tooth_records_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "treatment_plans" DROP CONSTRAINT "treatment_plans_patientId_fkey";
ALTER TABLE "treatment_plans" ADD CONSTRAINT "treatment_plans_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hijos de treatment_plans.
ALTER TABLE "treatment_plan_items" DROP CONSTRAINT "treatment_plan_items_planId_fkey";
ALTER TABLE "treatment_plan_items" ADD CONSTRAINT "treatment_plan_items_tenantId_planId_fkey"
  FOREIGN KEY ("tenantId", "planId") REFERENCES "treatment_plans"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" DROP CONSTRAINT "payments_treatmentPlanId_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_treatmentPlanId_patientId_fkey"
  FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payment_plans" DROP CONSTRAINT "payment_plans_treatmentPlanId_fkey";
ALTER TABLE "payment_plans" ADD CONSTRAINT "payment_plans_tenantId_treatmentPlanId_patientId_fkey"
  FOREIGN KEY ("tenantId", "treatmentPlanId", "patientId") REFERENCES "treatment_plans"("tenantId", "id", "patientId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hijos de payment_plans.
ALTER TABLE "installments" DROP CONSTRAINT "installments_paymentPlanId_fkey";
ALTER TABLE "installments" ADD CONSTRAINT "installments_tenantId_paymentPlanId_fkey"
  FOREIGN KEY ("tenantId", "paymentPlanId") REFERENCES "payment_plans"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hijos de locations.
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_locationId_fkey";
ALTER TABLE "appointments" ADD CONSTRAINT "appointments_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "payments" DROP CONSTRAINT "payments_locationId_fkey";
ALTER TABLE "payments" ADD CONSTRAINT "payments_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_items" DROP CONSTRAINT "inventory_items_locationId_fkey";
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_locationId_fkey";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenantId_locationId_fkey"
  FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hijos de inventory_items.
ALTER TABLE "inventory_movements" DROP CONSTRAINT "inventory_movements_itemId_fkey";
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_tenantId_itemId_fkey"
  FOREIGN KEY ("tenantId", "itemId") REFERENCES "inventory_items"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Hijos de location_schedules.
ALTER TABLE "location_schedule_ranges" DROP CONSTRAINT "location_schedule_ranges_scheduleId_fkey";
ALTER TABLE "location_schedule_ranges" ADD CONSTRAINT "location_schedule_ranges_tenantId_scheduleId_fkey"
  FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "location_schedules"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
