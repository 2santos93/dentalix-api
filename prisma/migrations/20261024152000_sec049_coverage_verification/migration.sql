-- SEC-049: la cobertura que habilita un convenio tiene que ser verificable.
-- `declaredById` es quien puso por última vez el pagador o el nº de afiliado
-- (puntero suave a users, como createdById); `verifiedById`/`verifiedAt`, la
-- verificación de un ADMIN, que se borra al cambiar el pagador o el número.
--
-- Aditiva y compatible hacia atrás: tres columnas NULLABLE sin DEFAULT (solo
-- catálogo, sin reescribir la tabla) y sin relleno: en las coberturas que ya
-- existían, `declaredById` NULL vale `createdById` (lo resuelve la API) y
-- quedan sin verificar. Sin índices: ninguna consulta filtra ni ordena por
-- ellas. La RLS FORCE de la tabla no cambia.
ALTER TABLE "patient_coverages"
  ADD COLUMN "declaredById" UUID,
  ADD COLUMN "verifiedById" UUID,
  ADD COLUMN "verifiedAt" TIMESTAMP(3);

-- Verificada = quién y cuándo, los dos o ninguno. NOT VALID + VALIDATE: el
-- ADD CONSTRAINT no recorre la tabla con el bloqueo fuerte.
ALTER TABLE "patient_coverages"
  ADD CONSTRAINT "patient_coverages_verified_check" CHECK (
    ("verifiedById" IS NULL) = ("verifiedAt" IS NULL)
  ) NOT VALID;
ALTER TABLE "patient_coverages" VALIDATE CONSTRAINT "patient_coverages_verified_check";
