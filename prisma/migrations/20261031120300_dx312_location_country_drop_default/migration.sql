-- Excepción G5.3 (DX-334): país de sede anterior a DX-312.
--
-- DX-312: la base deja de tener un país por defecto para las sedes (regla
-- del dueño: ningún país es el valor por defecto de nada). La API anterior
-- no lo usaba: su cliente de Prisma manda el país él mismo, y la única forma
-- en que lo hacía sin que nadie lo eligiera (el registro legado) ya la
-- rechaza el paso 0 del trigger de 20261031120000. Un INSERT por SQL sin
-- país falla por el NOT NULL de "countryCode". Esta migración no es lo que
-- protege de una clínica con un país que nadie eligió: eso es el paso 0.
--
-- ACCESS EXCLUSIVE breve sobre locations (solo catálogo); lock_timeout 5 s.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "locations" ALTER COLUMN "country" DROP DEFAULT;
