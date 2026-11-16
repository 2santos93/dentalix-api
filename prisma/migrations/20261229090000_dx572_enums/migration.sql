-- DX-572: valores de enum de las órdenes de estudios y referencias a
-- especialistas externos.
--
-- Cambios:
--   AuditResourceType  EXTERNAL_ORDER           emitir, ver, imprimir, anular,
--                                               ligar o desligar el resultado y
--                                               enviar la copia al paciente (y
--                                               su apertura y descarga públicas).
--                      EXTERNAL_ORDER_TEMPLATE  alta, edición y desactivación de
--                                               las plantillas.
--   EmailTemplate      external-order-copy      el email con el enlace de un
--                                               solo uso a la copia.
--
-- ADD VALUE va en su propio fichero: un valor nuevo no se puede usar en la
-- misma transacción que lo crea.
--
-- Fecha: posterior a la última migración existente (20261228090200,
-- DX-559).
--
-- Compatible hacia atrás: solo AÑADE valores que el código anterior no usa.

SET LOCAL lock_timeout = '5s';

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'EXTERNAL_ORDER';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'EXTERNAL_ORDER_TEMPLATE';
ALTER TYPE "EmailTemplate" ADD VALUE IF NOT EXISTS 'external-order-copy';
