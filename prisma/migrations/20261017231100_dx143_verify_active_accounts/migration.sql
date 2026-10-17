-- DX-143 (SEC-033): marca como verificadas (`users."emailVerifiedAt"`) las
-- cuentas anteriores a DX-029 que ya demostraron ser de quien las usa, para
-- que una invitación no las pueda «reclamar» (contraseña nueva) como cuenta
-- sin verificar. Criterio (README, «Cuentas sin enumeración ni pre-secuestro (DX-029)»):
--   1. la cuenta inició sesión con éxito alguna vez: hay un evento LOGIN de
--      audit_events con ella como actor (en cualquier clínica). Fecha: la del
--      primer LOGIN;
--   2. o es la dueña creada por el registro anterior a DX-029: ADMIN de una
--      clínica cuya membresía, el usuario y la clínica nacieron juntos (a
--      menos de 60 s; el registro los creaba en una misma transacción).
--      Fecha: la del alta del usuario.
-- Si cumple las dos, la más antigua. Solo cuentas no borradas.
--
-- Idempotente: solo toca filas con "emailVerifiedAt" NULL, y una segunda
-- ejecución no encuentra ninguna que cumpla el criterio sin fecha. No cambia
-- "passwordHash" ni "tokenVersion" (las sesiones siguen valiendo).
--
-- DX-113: audit_events (particionada) y clinic_memberships tienen RLS FORCE y
-- un owner sin superusuario ni BYPASSRLS no vería ninguna fila de clínica: el
-- UPDATE no haría nada en silencio. Se quita FORCE a las dos SOLO durante esta
-- transacción y se restaura al final (README, «Migraciones con datos»). En la
-- particionada basta con el padre: leída por el padre, la RLS de las
-- particiones no se aplica. `users` es global (sin RLS).
SET LOCAL lock_timeout = '5s';

ALTER TABLE "audit_events" NO FORCE ROW LEVEL SECURITY;
ALTER TABLE "clinic_memberships" NO FORCE ROW LEVEL SECURITY;

UPDATE "users" u
   SET "emailVerifiedAt" = v."verifiedAt"
  FROM (
    SELECT c."userId", min(c."at") AS "verifiedAt"
      FROM (
        SELECT e."actorUserId" AS "userId", min(e."occurredAt") AS "at"
          FROM "audit_events" e
         WHERE e."action" = 'LOGIN' AND e."actorUserId" IS NOT NULL
         GROUP BY e."actorUserId"
        UNION ALL
        SELECT m."userId", min(o."createdAt") AS "at"
          FROM "clinic_memberships" m
          JOIN "users" o ON o."id" = m."userId"
          JOIN "tenants" t ON t."id" = m."tenantId"
         WHERE m."role" = 'ADMIN'
           AND abs(extract(epoch FROM (o."createdAt" - t."createdAt"))) < 60
           AND abs(extract(epoch FROM (m."createdAt" - t."createdAt"))) < 60
         GROUP BY m."userId"
      ) c
     GROUP BY c."userId"
  ) v
 WHERE u."id" = v."userId"
   AND u."emailVerifiedAt" IS NULL
   AND u."deletedAt" IS NULL;

ALTER TABLE "clinic_memberships" FORCE ROW LEVEL SECURITY;
ALTER TABLE "audit_events" FORCE ROW LEVEL SECURITY;
