-- DX-273 (revisión DX-271, I1): sacar una cita de COMPLETED (a agendada,
-- confirmada, cancelada…) cambia lo que se hizo en esa visita y el intervalo
-- mínimo de la visita siguiente (DX-256). Solo ADMIN/DENTIST y con motivo.
--
-- El motivo es texto libre del personal: no va en `audit_events` (su metadata
-- solo admite códigos, DX-009). Se guarda aquí, una fila por salida (historial
-- completo), y el `audit_event` (reason COMPLETED_EXIT) apunta a ella por id.
--
-- Tabla nueva y vacía: sin backfill ni cambios en tablas existentes, salvo las
-- FK compuestas por tenant hacia `appointments` (SHARE ROW EXCLUSIVE un
-- instante; nada que validar). RLS FORCE por tenant, como el resto.
BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE TABLE public.appointment_status_reversals (
 id uuid NOT NULL,
 "tenantId" uuid NOT NULL,
 "patientId" uuid NOT NULL,
 "appointmentId" uuid NOT NULL,
 "fromStatus" public."AppointmentStatus" NOT NULL,
 "toStatus" public."AppointmentStatus" NOT NULL,
 reason varchar(500) NOT NULL,
 "actorUserId" uuid NOT NULL,
 "createdAt" timestamp(3) NOT NULL DEFAULT timezone('UTC', now()),
 CONSTRAINT appointment_status_reversals_pkey PRIMARY KEY (id),
 CONSTRAINT appointment_status_reversals_appointment_fkey
  FOREIGN KEY ("tenantId","patientId","appointmentId")
  REFERENCES public.appointments("tenantId","patientId",id) ON DELETE CASCADE ON UPDATE CASCADE,
 CONSTRAINT appointment_status_reversals_actor_fkey
  FOREIGN KEY ("actorUserId") REFERENCES public.users(id) ON DELETE RESTRICT ON UPDATE CASCADE,
 CONSTRAINT appointment_status_reversals_reason_check
  CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
 CONSTRAINT appointment_status_reversals_status_check
  CHECK ("fromStatus" = 'COMPLETED' AND "toStatus" <> 'COMPLETED')
);
CREATE INDEX appointment_status_reversals_appointment_idx
 ON public.appointment_status_reversals("tenantId","appointmentId","createdAt");
CREATE INDEX appointment_status_reversals_actor_idx
 ON public.appointment_status_reversals("actorUserId");

ALTER TABLE public.appointment_status_reversals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_status_reversals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON public.appointment_status_reversals
 USING ("tenantId"=NULLIF(current_setting('app.current_tenant',true),'')::uuid)
 WITH CHECK ("tenantId"=NULLIF(current_setting('app.current_tenant',true),'')::uuid);
-- Registro de evidencia: la app inserta y lee; nunca cambia ni borra (el
-- borrado en duro de la cita, retención/purga, va en cascada como owner).
-- Los privilegios por defecto le dan además UPDATE y DELETE: se quitan.
GRANT SELECT, INSERT ON public.appointment_status_reversals TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON public.appointment_status_reversals FROM dentalix_app;

COMMIT;
