-- DX-225: el índice de expresión de DX-128 ("tenantId", dx_phone_tail(phone))
-- no sirve bajo RLS y lo sustituye patients_tenant_phone_tail_idx
-- (20261020100300). CONCURRENTLY: no bloquea patients; única sentencia. La
-- función dx_phone_tail se queda: la usa el trigger de "phoneTail" y la
-- consulta del código anterior durante un despliegue escalonado.
DROP INDEX CONCURRENTLY IF EXISTS "patients_tenant_phone_tail_live_idx";
