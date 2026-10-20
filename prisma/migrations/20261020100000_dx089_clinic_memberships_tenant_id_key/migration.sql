-- DX-089: UNIQUE ("tenantId", "id") en clinic_memberships.
--
-- Destino de la FK compuesta (tenantId, membershipId) de membership_locations
-- (migración siguiente): la membresía restringida a una sede tiene que ser de
-- la MISMA clínica (SEC-004).
--
-- Compatible hacia atrás: solo AÑADE un índice que no puede fallar ("id" ya es
-- la PK). Sin CONCURRENTLY: clinic_memberships es pequeña (una fila por
-- miembro de cada clínica) y el bloqueo de escritura dura lo que tarda en
-- construirse; lock_timeout corta la migración en vez de encolar a la app si
-- otra transacción tiene la tabla.

SET LOCAL lock_timeout = '5s';

CREATE UNIQUE INDEX "clinic_memberships_tenant_id_key"
  ON "clinic_memberships"("tenantId", "id");
