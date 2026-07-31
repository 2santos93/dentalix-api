-- Pieza B: cuando un ítem del plan de tratamiento se marca DONE, se crea
-- automáticamente un ToothRecord en el odontograma. Esta columna liga ese
-- registro auto al ítem de plan que lo originó (puntero suave, sin FK) para
-- deduplicar: un ítem mirror-ea al odontograma a lo sumo una vez.
--
-- Aditiva y nullable => sin backfill. Columna sobre tabla RLS existente:
-- no requiere GRANT (ALTER DEFAULT PRIVILEGES ya cubre al rol dentalix_app),
-- misma nota que 20260727120000_add_reference_currency_country_city.
ALTER TABLE "tooth_records" ADD COLUMN "sourcePlanItemId" UUID;

-- CreateIndex
CREATE INDEX "tooth_records_tenantId_sourcePlanItemId_idx" ON "tooth_records"("tenantId", "sourcePlanItemId");
