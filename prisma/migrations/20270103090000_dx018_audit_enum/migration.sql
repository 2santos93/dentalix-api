-- DX-018: tipo de recurso de auditoría de la liquidación de honorarios
-- (cierre de la liquidación, lectura del detalle y de la vista previa).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20270102100200, DX-568)
-- y al umbral del lint (DX-148).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'COMMISSION_SETTLEMENT';
