-- DX-019-ter: el consentimiento firmado y las indicaciones post-operatorias
-- entregadas congelan la CLAVE del logo de la clínica al firmarse o
-- entregarse, como ya lo hacen la receta y el presupuesto firmado
-- (DX-019-bis, 20261203090000_dx019b_clinic_logo_key). Reimprimir uno de
-- estos documentos pinta el logo de entonces, no el de hoy. Se guarda la clave
-- y no los bytes: es por contenido (`logos/<clínica>-<16 hex>.<ext>`), su
-- objeto nunca cambia y nunca se borra (guarda
-- `src/architecture/no-logo-deletion.spec.ts`).
--
--   patient_consents."clinicLogoKey"                TEXT NULL
--   post_op_instruction_deliveries."clinicLogoKey"  TEXT NULL
--
-- NULL = «emitido sin logo»: se reimprime sin logo, nunca con el de hoy.
--
-- FUERA del hash del consentimiento (`consent-hash.ts`: texto, firmante,
-- firmas y signedAt): meter el logo en el contenido firmado haría que
-- cambiarlo entre el envío y la firma a distancia anulara el enlace (DX-243).
-- Las entregas no tienen hash. Las columnas nacen inmutables igualmente:
-- `patient_consents_immutable` rechaza todo UPDATE y
-- `post_op_instruction_deliveries_immutable` compara la fila entera salvo
-- "firstOpenedAt".
--
-- CHECK: exactamente lo que `clinicLogoPublicUrl` sabe pintar (y
-- `clinicLogoKeyToFreeze` congela), el mismo que el de DX-019-bis: una clave
-- `logos/<nombre>` de un solo segmento, sin `..`, o una URL http(s) anterior a
-- la subida desde Ajustes. Así congelar el logo nunca hace fallar una firma ni
-- una entrega. NOT VALID aquí (las filas existentes están a NULL) y VALIDATE
-- aparte (20261214090200_dx019t_clinic_logo_key_validate).
--
-- Expand puro: columnas NULL sin default (PG 16 solo toca el catálogo); el
-- ACCESS EXCLUSIVE dura lo que el ALTER. Una réplica anterior inserta sin
-- nombrar la columna y recibe NULL. El relleno de lo ya emitido va en
-- 20261214090100_dx019t_clinic_logo_key_backfill. Sin fechas: sin trigger UTC.
-- Las columnas heredan el grant de la tabla a dentalix_app y su RLS.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_consents"
  ADD COLUMN "clinicLogoKey" TEXT,
  ADD CONSTRAINT "patient_consents_clinic_logo_key_check" CHECK (
    "clinicLogoKey" IS NULL
    OR (
      "clinicLogoKey" ~ '^logos/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
      AND strpos("clinicLogoKey", '..') = 0
    )
    OR "clinicLogoKey" ~* '^https?://'
  ) NOT VALID;

ALTER TABLE "post_op_instruction_deliveries"
  ADD COLUMN "clinicLogoKey" TEXT,
  ADD CONSTRAINT "post_op_instruction_deliveries_clinic_logo_key_check" CHECK (
    "clinicLogoKey" IS NULL
    OR (
      "clinicLogoKey" ~ '^logos/[A-Za-z0-9_-][A-Za-z0-9._-]*$'
      AND strpos("clinicLogoKey", '..') = 0
    )
    OR "clinicLogoKey" ~* '^https?://'
  ) NOT VALID;
