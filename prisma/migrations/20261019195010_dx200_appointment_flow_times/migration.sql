-- DX-200: horas del flujo en la clínica y el estado al que vuelve «Deshacer
-- llegada». Columnas NULLABLE sin default (solo catálogo, sin reescribir la
-- tabla): las citas existentes quedan con null y siguen siendo válidas.
ALTER TABLE "appointments"
  ADD COLUMN "arrivedAt" TIMESTAMP(3),
  ADD COLUMN "seatedAt" TIMESTAMP(3),
  ADD COLUMN "readyForCheckoutAt" TIMESTAMP(3),
  ADD COLUMN "preArrivalStatus" "AppointmentStatus";

-- Cada estado del flujo lleva su hora (y las anteriores), en orden; la vuelta
-- de «Deshacer llegada» solo existe en ARRIVED y es agendada o confirmada.
-- COMPLETED y CANCELLED conservan las horas que tuvieran (o ninguna: las
-- citas antiguas). Los triggers de la tabla (última atención, saldos) solo
-- miran COMPLETED: los estados nuevos no los disparan.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_flow_times_check" CHECK (
    ("status" NOT IN ('ARRIVED', 'IN_CHAIR', 'READY_FOR_CHECKOUT') OR "arrivedAt" IS NOT NULL)
    AND ("status" NOT IN ('IN_CHAIR', 'READY_FOR_CHECKOUT') OR "seatedAt" IS NOT NULL)
    AND ("status" <> 'READY_FOR_CHECKOUT' OR "readyForCheckoutAt" IS NOT NULL)
    AND ("seatedAt" IS NULL OR ("arrivedAt" IS NOT NULL AND "seatedAt" >= "arrivedAt"))
    AND ("readyForCheckoutAt" IS NULL OR ("seatedAt" IS NOT NULL AND "readyForCheckoutAt" >= "seatedAt"))
    AND (("status" = 'ARRIVED') = ("preArrivalStatus" IS NOT NULL))
    AND ("preArrivalStatus" IS NULL OR "preArrivalStatus" IN ('SCHEDULED', 'CONFIRMED'))
  ) NOT VALID;
-- Las filas existentes no tienen horas ni estados nuevos: validar no cambia
-- nada, pero deja la restricción completa (también para las filas viejas).
ALTER TABLE "appointments" VALIDATE CONSTRAINT "appointments_flow_times_check";
