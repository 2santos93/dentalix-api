-- Palabras clave dentro de cadenas, comentarios y cuerpos $$ no cuentan:
-- ALTER TABLE "patients" ADD COLUMN x; UPDATE "patients" SET x = 1;
/* CREATE INDEX "p_idx" ON "patients" (x); */
CREATE FUNCTION dx_probe() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  UPDATE "patients" SET "firstName" = 'a;b' WHERE false;
  EXECUTE 'CREATE INDEX p ON patients (x)';
END
$fn$;
COMMENT ON FUNCTION dx_probe() IS 'ALTER TABLE "patients" DROP COLUMN x; CREATE INDEX q ON "payments" (y)';
