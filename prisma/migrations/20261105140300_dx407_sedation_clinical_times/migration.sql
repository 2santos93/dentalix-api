-- QA DX-407: hora clínica de la valoración y del checklist de la hoja de
-- sedación. Hasta ahora solo tenían la del servidor (`createdAt`), así que una
-- hoja documentada después (o la de la demo) mostraba la valoración y el
-- checklist DESPUÉS de las tomas y del egreso. Como las de toma, fármaco y
-- egreso, la anota quien registra (por defecto, ahora; nunca futura) y
-- `createdAt` sigue siendo el registro del servidor.
--
-- Aditiva y sin reescritura: columnas nulas sin valor por defecto (solo
-- catálogo, sin recorrer las filas ni disparar los triggers de inmutabilidad).
-- Las hojas ya registradas quedan con NULL y la API lee `createdAt`. Ninguna
-- consulta filtra ni ordena por ellas: no llevan índice.
ALTER TABLE "sedation_records" ADD COLUMN "assessedAt" TIMESTAMP(3);
ALTER TABLE "sedation_checklists" ADD COLUMN "checkedAt" TIMESTAMP(3);
