-- DX-509: el sobrecupo de una urgencia (DX-470) deja de serlo al moverla, y
-- la clave de idempotencia de «Atender sin cita» (DX-510) no cambia.
--
-- Red de la BD por debajo de la API (que ya hace todo esto explícito y lo
-- audita), para cualquier camino que actualice una cita:
--   * Un sobrecupo solo nace en el INSERT de «Atender sin cita»: un UPDATE no
--     puede encender "overbooked" (check_violation).
--   * Una cita en sobrecupo a la que se le cambia la hora ("start"/"end") o
--     el profesional deja de ser sobrecupo: NEW."overbooked" := false, y la
--     EXCLUDE appointments_no_overlap_per_provider pasa a contarla (23P01 si
--     choca). Las que se quedan en su hora no cambian (deshacer la llegada o
--     reactivar lo decide la API: hueco libre o mantener a sabiendas).
--   * "idempotencyKey" e "idempotencyFingerprint" se fijan en el INSERT y no
--     cambian (si cambiaran, una repetición ya no encontraría la cita o
--     aceptaría otro cuerpo con la misma clave), como en DX-274.
--
-- Trigger BEFORE UPDATE OF solo esas columnas: un UPDATE que no las nombra
-- (cambios de estado, notas, sillón) ni lo dispara. Sin SECURITY DEFINER: no
-- lee otras filas ni tablas. Compatible hacia atrás: el código anterior nunca
-- enciende "overbooked" en un UPDATE ni toca las columnas de idempotencia.
--
-- Bloqueo: CREATE TRIGGER toma SHARE ROW EXCLUSIVE sobre "appointments" un
-- instante (solo catálogo).
--
-- Vuelta atrás: DROP TRIGGER dx509_walk_in_guard ON public.appointments;
-- DROP FUNCTION public.dx509_walk_in_guard();

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.dx509_walk_in_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF (NEW."idempotencyKey", NEW."idempotencyFingerprint")
     IS DISTINCT FROM (OLD."idempotencyKey", OLD."idempotencyFingerprint")
  THEN
    RAISE EXCEPTION 'La clave de idempotencia de una cita se fija al crearla y no cambia (DX-510)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF NEW."overbooked" AND NOT OLD."overbooked" THEN
    RAISE EXCEPTION 'Un sobrecupo solo nace en «Atender sin cita» (DX-509)'
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD."overbooked" AND NEW."overbooked"
     AND (NEW."start", NEW."end", NEW."providerId")
         IS DISTINCT FROM (OLD."start", OLD."end", OLD."providerId")
  THEN
    NEW."overbooked" := false;
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER dx509_walk_in_guard
  BEFORE UPDATE OF "overbooked", "start", "end", "providerId",
    "idempotencyKey", "idempotencyFingerprint"
  ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION public.dx509_walk_in_guard();
