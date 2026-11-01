-- DX-330: platform_audit_events admite que un administrador de plataforma suba
-- el mínimo de conservación de la historia clínica a las clínicas que quedan
-- por debajo (`npm run retention:raise-floor`).
--
-- Cambios (solo amplían los CHECK de 20261101130200_dx359_platform_audit_actions):
--   action         + CLINICAL_RETENTION_MINIMUM_APPLIED  una clínica pasó de
--                                                        `before` a `after` años
--   resourceType   + TENANT                              la clínica afectada
--                                                        (resourceId = su id)
--
-- La metadata de estos eventos es `{ before, after }`: solo los dos plazos en
-- años, ningún dato de la clínica ni de sus pacientes.
--
-- Compatible hacia atrás: la API anterior solo escribe las acciones y recursos
-- que ya había, que siguen admitidos. Cada CHECK se sustituye en la misma
-- transacción (DROP + ADD), así que no hay ningún instante sin la restricción;
-- el ADD valida las filas existentes de una vez, y la tabla es pequeña
-- (acciones manuales de superadmins).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "platform_audit_events"
  DROP CONSTRAINT "platform_audit_events_action_check";
ALTER TABLE "platform_audit_events"
  ADD CONSTRAINT "platform_audit_events_action_check"
  CHECK ("action" IN ('JOB_RETRIED', 'MFA_ENROLLMENT_STARTED', 'MFA_ENABLED', 'PASSWORD_CHANGE', 'CLINICAL_RETENTION_MINIMUM_APPLIED'));

ALTER TABLE "platform_audit_events"
  DROP CONSTRAINT "platform_audit_events_resource_type_check";
ALTER TABLE "platform_audit_events"
  ADD CONSTRAINT "platform_audit_events_resource_type_check"
  CHECK ("resourceType" IN ('JOB', 'USER', 'TENANT'));
