-- DX-540: registro profesional del autor en la evolución y aviso de la clínica.
--
-- Cambios (aditivos; ninguna fila se reescribe ni se borra):
--   clinical_entries."authorProfessionalLicense"  TEXT NULL
--       Registro profesional del autor congelado al firmar (el de su
--       membresía en la clínica en ese momento). Lo escribe la API en el
--       INSERT; el trigger clinical_entries_immutable (DX-038) impide
--       cambiarlo después, así que editar el registro del profesional no
--       toca lo ya firmado. Las evoluciones anteriores quedan con NULL: no se
--       inventa un registro que no constaba al firmarlas.
--       CHECK como el de clinic_memberships (1..60 sin espacios en los
--       extremos), NOT VALID aquí y validado en la migración siguiente.
--   tenants."clinicalEntryLicenseWarning"  BOOLEAN NOT NULL DEFAULT false
--       Ajuste de la clínica (solo ADMIN, PUT /clinical-entries/settings,
--       auditado): avisar al firmar una evolución sin registro profesional.
--       No bloquea nunca. Desactivado en todas las clínicas: ninguna regla
--       lo deduce del país (DX-334).
--
-- Bloqueos: ADD COLUMN con DEFAULT constante no reescribe la tabla
-- (Postgres ≥ 11) y ADD CONSTRAINT ... NOT VALID no la recorre: ACCESS
-- EXCLUSIVE de milisegundos. Compatible hacia atrás: una réplica anterior de
-- la API no lee ni escribe las columnas nuevas (la evolución queda con NULL).

-- DB-025: si una transacción larga retiene la tabla, falla rápido en vez de
-- encolar las escrituras de la historia clínica detrás de su bloqueo.
SET LOCAL lock_timeout = '5s';

ALTER TABLE "clinical_entries" ADD COLUMN "authorProfessionalLicense" TEXT;
ALTER TABLE "clinical_entries" ADD CONSTRAINT "clinical_entries_author_professional_license_check"
  CHECK ("authorProfessionalLicense" IS NULL OR (length("authorProfessionalLicense") BETWEEN 1 AND 60 AND "authorProfessionalLicense" = btrim("authorProfessionalLicense"))) NOT VALID;

ALTER TABLE "tenants" ADD COLUMN "clinicalEntryLicenseWarning" BOOLEAN NOT NULL DEFAULT false;
