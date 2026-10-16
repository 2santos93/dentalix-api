-- DX-040 (1/2): estados PRESENTED y REJECTED del plan de tratamiento.
--
-- Va SOLO en su migración: Postgres no deja usar un valor añadido con
-- ALTER TYPE ... ADD VALUE dentro de la misma transacción que lo añade, y la
-- migración siguiente (20261017090100_treatment_plan_alternatives) lo usa en
-- sus CHECK y en el trigger. Aditiva: ninguna fila existente cambia.
ALTER TYPE "TreatmentPlanStatus" ADD VALUE IF NOT EXISTS 'PRESENTED' BEFORE 'ACCEPTED';
ALTER TYPE "TreatmentPlanStatus" ADD VALUE IF NOT EXISTS 'REJECTED' AFTER 'ACCEPTED';
