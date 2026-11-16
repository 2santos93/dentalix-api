-- DX-017: tipos de recurso de auditoría del laboratorio dental (laboratorio
-- y sus servicios: alta, cambios y desactivación) y de la orden de
-- laboratorio (alta, cambios, envío, recepción, revisión, anulación e
-- impresión).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261229190300, DX-190)
-- y al umbral del lint (DX-148).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'DENTAL_LAB';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'DENTAL_LAB_ORDER';
