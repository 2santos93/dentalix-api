-- DX-222: enums de las indicaciones postoperatorias.
--
-- Cambios:
--   PostOpDeliveryChannel   canal de una entrega: impresa, email o enlace
--                           para WhatsApp.
--   AuditResourceType       POSTOP_TEMPLATE (plantillas) y POSTOP_DELIVERY
--                           (entregas al paciente).
--
-- ADD VALUE va en su propio fichero: el valor nuevo no se puede usar en la
-- misma transacción que lo crea (su índice parcial de audit_events va en
-- 20261020000200_dx222_audit_events_idx).
--
-- Compatible hacia atrás: solo AÑADE un tipo y dos valores que el código
-- anterior no conoce ni usa.

SET LOCAL lock_timeout = '5s';

CREATE TYPE "PostOpDeliveryChannel" AS ENUM ('PRINT', 'EMAIL', 'WHATSAPP_LINK');

ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'POSTOP_TEMPLATE';
ALTER TYPE "AuditResourceType" ADD VALUE IF NOT EXISTS 'POSTOP_DELIVERY';
