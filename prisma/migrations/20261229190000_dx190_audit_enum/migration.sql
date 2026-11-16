-- DX-190: tipos de recurso de auditoría del caso de ortodoncia (alta, cambios
-- de cabecera y de estado) y de sus controles (cada control registrado).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261228120200, DX-290)
-- y al umbral del lint (DX-148).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ORTHO_CASE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'ORTHO_VISIT';
