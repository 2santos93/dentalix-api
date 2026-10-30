-- DX-359: platform_audit_events admite el alta del MFA del superadmin y su
-- cambio de contraseña.
--
-- Cambios (solo amplían los CHECK de 20261018110000_dx220_job_workers_platform_audit):
--   action         + MFA_ENROLLMENT_STARTED  POST /platform/mfa/enrollment
--                  + MFA_ENABLED             POST /platform/mfa/enrollment/confirm
--                  + PASSWORD_CHANGE         POST /me/password con sesión de
--                                            plataforma (sin clínica: no puede
--                                            ir a audit_events, que exige tenant)
--   resourceType   + USER                    el propio superadmin (resourceId =
--                                            su id)
--
-- La metadata de estos eventos va vacía: ni el secreto TOTP, ni el código, ni
-- el otpauth URI, ni nada de la contraseña.
--
-- Compatible hacia atrás: la API anterior solo escribe JOB_RETRIED/JOB, que
-- siguen admitidos. Se sustituye cada CHECK en la misma transacción (DROP +
-- ADD NOT VALID + VALIDATE): no hay ningún instante sin la restricción y la
-- validación solo lee la tabla, pequeña (acciones manuales de superadmins).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "platform_audit_events"
  DROP CONSTRAINT "platform_audit_events_action_check";
ALTER TABLE "platform_audit_events"
  ADD CONSTRAINT "platform_audit_events_action_check"
  CHECK ("action" IN ('JOB_RETRIED', 'MFA_ENROLLMENT_STARTED', 'MFA_ENABLED', 'PASSWORD_CHANGE'))
  NOT VALID;
ALTER TABLE "platform_audit_events"
  VALIDATE CONSTRAINT "platform_audit_events_action_check";

ALTER TABLE "platform_audit_events"
  DROP CONSTRAINT "platform_audit_events_resource_type_check";
ALTER TABLE "platform_audit_events"
  ADD CONSTRAINT "platform_audit_events_resource_type_check"
  CHECK ("resourceType" IN ('JOB', 'USER'))
  NOT VALID;
ALTER TABLE "platform_audit_events"
  VALIDATE CONSTRAINT "platform_audit_events_resource_type_check";
