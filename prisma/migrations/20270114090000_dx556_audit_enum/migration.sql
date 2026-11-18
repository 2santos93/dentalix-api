-- DX-556: tipo de recurso de auditoría de los prospectos (alta, edición,
-- cambio de etapa, notas, conversión en paciente, lecturas de la lista y la
-- anonimización de la retención).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20270111090400, DX-101)
-- y al umbral del lint (DX-148).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'LEAD';
