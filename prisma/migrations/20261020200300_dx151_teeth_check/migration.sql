-- DX-151: el CHECK de dientes de patient_documents valida cada ELEMENTO
-- contra la lista FDI.
--
-- Por qué: el CHECK de 20261020200100 unía el array con comas y aplicaba el
-- patrón FDI a la cadena. Un elemento con comas dentro lo burlaba:
-- ARRAY['11,12'] pasaba con cardinalidad 1, así que tampoco lo veía el tope
-- de 8 ('11,12,13,…,21' en un solo elemento) y el filtro GIN
-- toothNumbers @> ARRAY['36'] no encontraba esas filas. Un array de 2
-- dimensiones daba otro error en vez de 23514.
--
-- Ahora:
--   - cada elemento está en la lista cerrada de los 52 códigos FDI
--     (32 permanentes 11-48 y 20 temporales 51-85), con <@: un NULL nunca es
--     igual a nada, así que un elemento NULL también falla; '{}' pasa;
--   - una sola dimensión (<@ aplana los arrays: sin esto un 2D pasaría);
--     array_ndims('{}') es NULL, por eso el coalesce;
--   - el tope de 8 sigue en patient_documents_teeth_max (sin cambios).
-- Los duplicados (['11','11']) los acepta la BD: la API los quita antes
-- (validateToothNumbers).
--
-- La tabla es de este mismo cambio y aún no tiene datos fuera de los tests;
-- ADD CONSTRAINT valida las filas existentes (FORCE no oculta filas a un
-- CHECK). schema.prisma no cambia: Prisma no declara CHECKs.

SET LOCAL lock_timeout = '5s';

ALTER TABLE "patient_documents" DROP CONSTRAINT "patient_documents_teeth_fdi";

ALTER TABLE "patient_documents" ADD CONSTRAINT "patient_documents_teeth_fdi"
  CHECK (
    COALESCE(pg_catalog.array_ndims("toothNumbers"), 1) = 1
    AND "toothNumbers" <@ ARRAY[
        '11', '12', '13', '14', '15', '16', '17', '18',
        '21', '22', '23', '24', '25', '26', '27', '28',
        '31', '32', '33', '34', '35', '36', '37', '38',
        '41', '42', '43', '44', '45', '46', '47', '48',
        '51', '52', '53', '54', '55', '61', '62', '63',
        '64', '65', '71', '72', '73', '74', '75', '81',
        '82', '83', '84', '85'
    ]::text[]
  );
