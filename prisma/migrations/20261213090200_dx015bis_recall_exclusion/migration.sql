-- DX-015-bis (porción 2): exclusión entre tipos de recall (D9/D10). DDL.
--
-- Cambios:
--   recall_types     el CHECK del grupo de exclusión pasa a la forma del
--                    contrato de la API (D13): 1–40 de [A-Z0-9_]. El anterior
--                    exigía una letra al principio; relajarlo no puede dejar
--                    filas que no cumplan.
--   patient_recalls  + "excludedAt": cuándo lo desactivó la exclusión (otro
--                    recall de un tipo del mismo grupo pasó a activo). NULL si
--                    está activo o lo desactivó el clínico. Solo con él un DONE
--                    posterior de un disparador del tipo lo REACTIVA («el
--                    último procedimiento manda»): un recall que retiró el
--                    clínico a mano sigue retirado. La app lo vacía al
--                    reactivarlo (DONE o PUT).
--   función          dx_recall_exclusion_backfill: el relleno único de una
--                    clínica (20261213090300 la llama por cada una; los tests,
--                    sobre la suya). NO la llama la app.
--
-- El efecto en los eventos (DONE y PUT) lo aplica la app en la transacción del
-- cambio (src/modules/recall/infrastructure/recall-exclusion.ts).
--
-- Bloqueos: ADD COLUMN sin DEFAULT es solo de catálogo (ACCESS EXCLUSIVE un
-- instante); el CHECK nuevo recorre recall_types (pocas filas por clínica).
-- lock_timeout para fallar limpio si algo las retiene.
--
-- Compatible hacia atrás durante el despliegue: la app vieja no lee ni
-- escribe "excludedAt", y un PUT viejo que reactive un recall excluido lo deja
-- activo con "excludedAt" puesto, que la app nueva solo mira en los inactivos.
--
-- Vuelta atrás: DROP FUNCTION public.dx_recall_exclusion_backfill(uuid);
-- ALTER TABLE "patient_recalls" DROP COLUMN "excludedAt"; y reponer el CHECK
-- anterior (solo si ningún grupo empieza por cifra o «_»).

SET LOCAL lock_timeout = '5s';

ALTER TABLE "recall_types"
  DROP CONSTRAINT "recall_types_exclusion_group_check",
  ADD CONSTRAINT "recall_types_exclusion_group_check"
    CHECK ("exclusionGroup" IS NULL OR "exclusionGroup" ~ '^[A-Z0-9_]{1,40}$');

ALTER TABLE "patient_recalls" ADD COLUMN "excludedAt" TIMESTAMP(3);

COMMENT ON COLUMN "patient_recalls"."excludedAt" IS
  'DX-015-bis: cuándo lo desactivó la exclusión entre tipos del mismo grupo; un DONE posterior de un disparador lo reactiva. NULL si activo o retirado a mano.';

-- ---------------------------------------------------------------------------
-- dx_recall_exclusion_backfill: la porción 1 dejó pacientes con dos recalls
-- activos de tipos del mismo grupo (el relleno creó ambos). Por cada paciente
-- y grupo con dos o más activos, se queda activo el de "lastDoneAt" más
-- reciente; con la misma base, el de "intervalMonths" menor (el perio) y luego
-- el id menor. Los demás pasan a inactivos con "excludedAt" (un DONE
-- posterior de su disparador los reactiva). No borra nada. Solo tipos vivos.
--
-- Sin búsquedas por fila ni auto-joins de patient_recalls (ver la cabecera de
-- 20261212090400): UNA lectura de los recalls activos de la clínica con su
-- tipo (recall_types es pequeña) y la ventana por paciente y grupo; los
-- perdedores van a un array y se escriben por la PK (`= ANY`), bloqueados
-- antes en orden de id (como dx_recall_visit_location_refresh). Repetirla no
-- cambia nada: tras la primera pasada no queda ningún grupo con dos activos.
-- Con la RLS de quien llama: fija antes app.current_tenant = p_tenant.
-- Devuelve cuántos desactivó.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.dx_recall_exclusion_backfill(p_tenant uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY INVOKER
  SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
  v_ids uuid[];
  v_count integer;
BEGIN
  SELECT coalesce(pg_catalog.array_agg(w."id" ORDER BY w."id"), '{}'::uuid[])
    INTO v_ids
    FROM (
      SELECT pr."id",
             pg_catalog.row_number() OVER (
               PARTITION BY pr."patientId", rt."exclusionGroup"
               ORDER BY pr."lastDoneAt" DESC, pr."intervalMonths" ASC, pr."id" ASC
             ) AS "rank"
        FROM public."patient_recalls" pr
        JOIN public."recall_types" rt
          ON rt."tenantId" = pr."tenantId" AND rt."id" = pr."recallTypeId"
       WHERE pr."tenantId" = p_tenant
         AND pr."active"
         AND rt."exclusionGroup" IS NOT NULL
         AND rt."deletedAt" IS NULL
    ) w
   WHERE w."rank" > 1;

  IF pg_catalog.cardinality(v_ids) = 0 THEN
    RETURN 0;
  END IF;

  PERFORM 1
     FROM (SELECT pr."id"
             FROM public."patient_recalls" pr
            WHERE pr."id" = ANY (v_ids)
            ORDER BY pr."id"
              FOR NO KEY UPDATE OF pr) locked;

  UPDATE public."patient_recalls" pr
     SET "active" = false,
         "excludedAt" = pg_catalog.timezone('UTC', pg_catalog.now()),
         "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
   WHERE pr."id" = ANY (v_ids)
     AND pr."tenantId" = p_tenant
     AND pr."active";
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

COMMENT ON FUNCTION public.dx_recall_exclusion_backfill(uuid) IS
  'DX-015-bis: relleno único de la exclusión de una clínica (solo la migración 20261213090300 y sus tests; nunca la app).';

REVOKE ALL ON FUNCTION public.dx_recall_exclusion_backfill(uuid) FROM PUBLIC;
