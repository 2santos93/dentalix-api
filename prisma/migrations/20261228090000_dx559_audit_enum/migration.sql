-- DX-559: tipo de recurso de auditoría de las plantillas de plan de
-- tratamiento (alta, edición y desactivación).
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261227090200,
-- DX-263).
--
-- Compatible hacia atrás: solo AÑADE un valor que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'TREATMENT_PLAN_TEMPLATE';
