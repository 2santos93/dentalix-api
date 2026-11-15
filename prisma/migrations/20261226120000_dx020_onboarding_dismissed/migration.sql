-- DX-020: tarjeta «Pon en marcha tu clínica» del panel del ADMIN.
--
-- Un solo campo, nullable y sin default: cuándo la descartó el ADMIN (NULL =
-- se muestra). El estado de los pasos no se guarda: lo calcula la API con los
-- datos que ya existen (GET /onboarding/status).
--
-- ADD COLUMN nullable sin default solo toca el catálogo (no reescribe la
-- tabla); `tenants` tiene una fila por clínica. lock_timeout por si un
-- cambio de ajustes tiene la fila bloqueada (FOR UPDATE): falla rápido en vez
-- de dejar la API en cola detrás.
--
-- Compatible hacia atrás: el código anterior no lee la columna.
--
-- Vuelta atrás: ALTER TABLE "tenants" DROP COLUMN "onboardingDismissedAt";

SET LOCAL lock_timeout = '5s';

ALTER TABLE "tenants" ADD COLUMN "onboardingDismissedAt" TIMESTAMP(3);
