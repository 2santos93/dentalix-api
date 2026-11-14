-- DX-294: el refresco de cartera siempre con plan a medida.
--
-- `patient_ledgers_refresh(tenants, patients)` corre en el trigger de
-- sentencia de `patients` (y en los de planes, pagos y saldos migrados). Tras
-- 5 llamadas en una conexión, PL/pgSQL pasa sus consultas al plan GENÉRICO,
-- que no conoce los arrays (estima `unnest` = 1 fila); si además las
-- estadísticas de `patients` son de antes de una importación grande (el
-- autoanalyze llega hasta un minuto después), elige un nested loop
-- pacientes del tenant × ids de la sentencia: deshacer 10.000 pacientes recién
-- importados pasaba de ~1 s a 10–30 s y el proxy de la web cortaba la
-- petición. Con el plan a medida los arrays se conocen y el mismo estado de
-- estadísticas da un merge/hash join lineal (EXPLAIN en REPORT-DX-294).
--
-- Solo cambia la configuración de la función (no su cuerpo ni su semántica);
-- conserva su `search_path`. Coste: se replanifica en cada llamada (~1 ms con
-- un paciente). Un `CREATE OR REPLACE FUNCTION` posterior debe repetir el
-- `SET plan_cache_mode`: lo vigila test/patient-imports-undo-10k.int-spec.ts.
--
-- Vuelta atrás:
--   ALTER FUNCTION public."patient_ledgers_refresh"(uuid[], uuid[]) RESET plan_cache_mode;

ALTER FUNCTION public."patient_ledgers_refresh"(uuid[], uuid[])
  SET plan_cache_mode = force_custom_plan;
