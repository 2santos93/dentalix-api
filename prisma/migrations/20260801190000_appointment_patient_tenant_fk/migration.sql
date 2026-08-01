-- Aislamiento por tenant de las citas, a nivel DB.
--
-- "appointments"."patientId" tenia una FK a "patients"("id"), que solo garantiza
-- "el paciente existe en ALGUN tenant": las FK de Postgres se chequean saltando
-- la RLS, asi que se podia crear una cita contra un paciente de OTRA clinica.
-- La validacion de aplicacion ya lo cierra (CreateAppointmentUseCase resuelve el
-- paciente por su repo, que filtra por tenant via RLS); esto lo hace ademas
-- IMPOSIBLE a nivel DB, para cualquier ruta futura que se salte el use-case.
--
-- Pre-flight verificado antes de aplicar: 0 citas cuyo paciente pertenezca a otro
-- tenant, y 0 citas con paciente inexistente. Si hubiera filas malas, el ADD
-- CONSTRAINT falla ruidoso, que es lo correcto (hay que limpiar los datos antes).

-- CreateIndex: la FK compuesta necesita un UNIQUE sobre las columnas referidas.
CREATE UNIQUE INDEX "patients_tenant_id_key" ON "patients"("tenantId", "id");

-- DropForeignKey: la FK antigua, que no miraba el tenant.
ALTER TABLE "appointments" DROP CONSTRAINT "appointments_patientId_fkey";

-- AddForeignKey: (tenantId, patientId) -> patients(tenantId, id).
-- Se conserva la semantica anterior en el borrado (RESTRICT por defecto en una
-- relacion obligatoria): una cita nunca deja huerfano a su paciente.
ALTER TABLE "appointments"
  ADD CONSTRAINT "appointments_tenantId_patientId_fkey"
  FOREIGN KEY ("tenantId", "patientId") REFERENCES "patients"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- Grants/RLS: sin cambios. Corre con el rol owner "dentalix" (via DIRECT_URL);
-- una FK no altera los privilegios DML de dentalix_app, y la RLS de ambas tablas
-- queda intacta (la FK es ortogonal a la RLS -- de hecho es justo por eso que
-- hacia falta incluir el tenant en la propia FK).
