-- DX-133-bis: el nombre de un tipo de cita es único en la clínica SIN
-- distinguir mayúsculas ni espacios de los extremos, entre los vivos.
--
-- Hasta ahora el único parcial era sobre "name" a secas: «Limpieza» y
-- «limpieza» convivían y la agenda mostraba dos tipos indistinguibles.
--
-- Aditiva y sin perder filas: antes del índice se resuelven los choques que
-- ya existan. De cada grupo (clínica, lower(btrim(name))) se conserva el más
-- antiguo tal cual; a los demás se les añade « (repetido N)» al nombre
-- (recortando para respetar el CHECK de 60). Si una clínica ya tuviera un
-- tipo llamado exactamente así, el CREATE INDEX falla y la migración entera
-- se revierte (Prisma la corre en una transacción): falla en voz alta, no
-- en silencio. Se recorre por clínica porque appointment_types tiene RLS con
-- FORCE. El renombrado no deja audit_event: es de la migración, no de un
-- usuario, y queda descrito aquí.
SET lock_timeout = '5s';

DO $$
DECLARE
  t uuid;
BEGIN
  FOR t IN SELECT "id" FROM public."tenants" ORDER BY "id" LOOP
    PERFORM set_config('app.current_tenant', t::text, true);
    UPDATE public."appointment_types" a
       SET "name" = left(btrim(a."name"), 60 - length(' (repetido ' || d.n || ')'))
                    || ' (repetido ' || d.n || ')',
           "updatedAt" = CURRENT_TIMESTAMP
      FROM (
        SELECT "id",
               row_number() OVER (
                 PARTITION BY lower(btrim("name")) ORDER BY "createdAt", "id"
               ) AS n
          FROM public."appointment_types"
         WHERE "tenantId" = t
           AND "deletedAt" IS NULL
      ) d
     WHERE a."id" = d."id" AND d.n > 1;
  END LOOP;
  PERFORM set_config('app.current_tenant', '', true);
END
$$;

-- Índice de EXPRESIÓN: schema.prisma no lo declara (Prisma no lo expresa).
CREATE UNIQUE INDEX "appointment_types_tenant_name_ci_key"
  ON "appointment_types" ("tenantId", lower(btrim("name")))
  WHERE "deletedAt" IS NULL;
DROP INDEX "appointment_types_tenant_name_key";
