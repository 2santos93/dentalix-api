-- DX-566: tipo de recurso de auditoría del control postoperatorio (alta al
-- marcar hecho, intentos de llamada, cierre, anulación, recálculo y la lista
-- del día).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20270104090000, DX-564)
-- y al umbral del lint (DX-148).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'POST_OP_CHECK';
