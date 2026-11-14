-- DX-019-bis (B): la receta y la aceptación firmada del presupuesto congelan
-- la CLAVE del logo de la clínica al emitirse, como ya congelan los datos
-- fiscales. Reimprimir un documento emitido pinta el logo de entonces, no el
-- de hoy. Se guarda la clave y no los bytes: es por contenido
-- (`logos/<clínica>-<16 hex>.<ext>`), su objeto nunca cambia y nunca se borra
-- (guarda `src/architecture/no-logo-deletion.spec.ts`).
--
--   prescriptions."clinicLogoKey"               TEXT NULL
--   treatment_plan_acceptances."clinicLogoKey"  TEXT NULL
--
-- NULL = «emitido sin logo»: se reimprime sin logo, nunca con el de hoy.
--
-- FUERA de los hashes (receta v4, presupuesto v4): meter el logo en el
-- contenido firmado haría que cambiarlo entre el envío y la firma anulara el
-- enlace a distancia (DX-415). Las columnas nacen inmutables igualmente:
-- `prescriptions_immutable` compara la fila entera salvo las columnas de
-- anulación y `treatment_plan_acceptances_immutable` rechaza todo UPDATE.
--
-- CHECK: exactamente lo que `clinicLogoPublicUrl` sabe pintar (y
-- `clinicLogoKeyToFreeze` congela): una clave `logos/<nombre>` de un solo
-- segmento, sin `..`, o una URL http(s) anterior a la subida desde Ajustes
-- (la columna `tenants."logoUrl"` no tiene CHECK y aún puede tenerla). Así
-- congelar el logo nunca hace fallar una emisión. NOT VALID aquí (las filas
-- existentes están a NULL) y VALIDATE aparte
-- (20261203090200_dx019b_clinic_logo_key_validate), como
-- 20261114100100_dx019_prescription_fiscal_check_validate.
--
-- Expand puro: columnas NULL sin default (PG 16 solo toca el catálogo); el
-- ACCESS EXCLUSIVE dura lo que el ALTER. Una réplica anterior inserta sin
-- nombrar la columna y recibe NULL. El relleno de lo ya emitido va en
-- 20261203090100_dx019b_clinic_logo_key_backfill. Sin fechas: sin trigger UTC.
-- Las columnas heredan el grant de la tabla a dentalix_app y su RLS.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "prescriptions"
  ADD COLUMN "clinicLogoKey" TEXT,
  ADD CONSTRAINT "prescriptions_clinic_logo_key_check" CHECK (
    "clinicLogoKey" IS NULL
    OR (
      "clinicLogoKey" ~ '^logos/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
      AND strpos("clinicLogoKey", '..') = 0
    )
    OR "clinicLogoKey" ~* '^https?://'
  ) NOT VALID;

ALTER TABLE "treatment_plan_acceptances"
  ADD COLUMN "clinicLogoKey" TEXT,
  ADD CONSTRAINT "treatment_plan_acceptances_clinic_logo_key_check" CHECK (
    "clinicLogoKey" IS NULL
    OR (
      "clinicLogoKey" ~ '^logos/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
      AND strpos("clinicLogoKey", '..') = 0
    )
    OR "clinicLogoKey" ~* '^https?://'
  ) NOT VALID;
