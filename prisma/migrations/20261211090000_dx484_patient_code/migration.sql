-- DX-484: código del paciente para el software de imagen.
--
-- Por qué: el software de imagen (radiografía digital, cámara intraoral,
-- tomografía) identifica al paciente por un código corto que la clínica teclea
-- o exporta. El modelo no tenía número de historia: el id es un UUID que nadie
-- puede dictar ni escribir. Cada paciente recibe un número corto, único en su
-- clínica y que nunca cambia (tampoco al archivarlo; un código no se
-- reutiliza).
--
-- Cambios (solo esquema; el relleno, el índice único y la validación van en
-- ficheros propios, patrón de DX-225/DX-287):
--   patient_code_counters      último código asignado por clínica (una fila
--                              por tenant). Lo escriben solo el trigger de alta
--                              y el relleno: UPSERT en la transacción del alta,
--                              así que dos altas a la vez de la misma clínica
--                              se serializan en esa fila y nunca reciben el
--                              mismo número; un alta deshecha deshace también
--                              su número.
--   patients."patientCode"     el código. Lo asigna SIEMPRE el trigger
--                              patients_code_assign (BEFORE INSERT): un valor
--                              que traiga el INSERT se sobrescribe, la app no
--                              elige el código. patients_code_immutable
--                              (BEFORE UPDATE OF "patientCode") rechaza
--                              cambiarlo; hasta la validación
--                              (20261211090400) deja pasar solo 0 → número,
--                              que es lo que hace el relleno.
--
-- Reglas en la BD:
--   * RLS FORCE con NULLIF en patient_code_counters (DX-251). El trigger corre
--     con el rol de quien inserta: la app (dentalix_app) solo puede tocar la
--     fila de la clínica fijada en `app.current_tenant`, la misma que la RLS
--     de patients ya le exige al paciente.
--   * Grants: dentalix_app puede leer e insertar contadores y actualizar solo
--     "lastNumber"; ni DELETE ni TRUNCATE (un contador que vuelve atrás
--     repetiría códigos).
--   * FK a tenants ON DELETE CASCADE (como location_reminder_settings): el
--     contador es contabilidad de la clínica y no tiene sentido sin ella; un
--     id de clínica nunca se reutiliza, así que no hay códigos que repetir.
--     Con RESTRICT, la fila que nace con el primer paciente impediría borrar
--     la clínica tras borrar sus pacientes (limpiezas de test y bajas).
--
-- Bloqueo: ADD COLUMN con DEFAULT constante no reescribe la tabla (PG ≥ 11):
-- las filas existentes leen 0 sin tocarse. ADD COLUMN y CREATE TRIGGER toman
-- ACCESS EXCLUSIVE / SHARE ROW EXCLUSIVE solo un instante; lock_timeout evita
-- quedar encolado detrás de una transacción larga y bloquear a los demás
-- detrás. La columna nace nullable y sin CHECK: un CHECK NOT VALID ya se
-- comprueba en cada UPDATE, y una edición de un paciente aún sin relleno
-- (código 0) fallaría; va después del relleno (20261211090300).
--
-- Compatible hacia atrás: el código anterior no lee ni escribe la columna; sus
-- INSERT reciben el código del trigger y sus UPDATE no la nombran.

SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "patient_code_counters" (
    "tenantId" UUID NOT NULL,
    "lastNumber" INTEGER NOT NULL,

    CONSTRAINT "patient_code_counters_pkey" PRIMARY KEY ("tenantId")
);

-- AddForeignKey
ALTER TABLE "patient_code_counters" ADD CONSTRAINT "patient_code_counters_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "patient_code_counters"
  ADD CONSTRAINT "patient_code_counters_last_check" CHECK ("lastNumber" > 0);

-- RLS
ALTER TABLE "patient_code_counters" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "patient_code_counters"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);
ALTER TABLE "patient_code_counters" FORCE ROW LEVEL SECURITY;

-- Grants: los privilegios por defecto dan a dentalix_app SELECT, INSERT,
-- UPDATE y DELETE; aquí se recortan (REVOKE de tabla primero).
REVOKE UPDATE, DELETE, TRUNCATE ON "patient_code_counters" FROM dentalix_app;
GRANT SELECT, INSERT ON "patient_code_counters" TO dentalix_app;
GRANT UPDATE ("lastNumber") ON "patient_code_counters" TO dentalix_app;

-- AlterTable
ALTER TABLE "patients" ADD COLUMN "patientCode" INTEGER DEFAULT 0;

-- Alta: el código sale siempre del contador de la clínica del paciente.
CREATE FUNCTION public."dx_patients_code_assign"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  INSERT INTO public."patient_code_counters" AS c ("tenantId", "lastNumber")
  VALUES (NEW."tenantId", 1)
  ON CONFLICT ("tenantId") DO UPDATE SET "lastNumber" = c."lastNumber" + 1
  RETURNING c."lastNumber" INTO NEW."patientCode";
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patients_code_assign"
  BEFORE INSERT ON "patients"
  FOR EACH ROW EXECUTE FUNCTION public."dx_patients_code_assign"();

-- Edición: el código no cambia. Hasta la validación solo pasa 0 → número
-- (el relleno de 20261211090100); 20261211090400 retira esa excepción.
CREATE FUNCTION public."dx_patients_code_immutable"() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF NEW."patientCode" IS DISTINCT FROM OLD."patientCode"
     AND NOT (OLD."patientCode" = 0 AND NEW."patientCode" > 0) THEN
    RAISE EXCEPTION 'El código del paciente no se puede cambiar (DX-484)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "patients_code_immutable"
  BEFORE UPDATE OF "patientCode" ON "patients"
  FOR EACH ROW EXECUTE FUNCTION public."dx_patients_code_immutable"();
