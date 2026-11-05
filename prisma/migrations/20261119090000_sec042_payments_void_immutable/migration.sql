-- SEC-042: un abono anulado es definitivo, y eso vive en la BD.
--
-- Hallazgo (revisión de DX-215, hallazgo 3): `payments` no impedía editar un
-- abono ya anulado. El trigger de `payment_promises` (DX-215) reabre un
-- compromiso CUMPLIDO solo si en la misma transacción se escribió un abono
-- anulado del paciente (la versión viva de la fila la escribió ella: xmin = su
-- xid). Con SQL directo como `dentalix_app`, un `UPDATE payments SET notes =
-- notes` sobre un abono anulado antiguo cumplía esa condición y reabría un
-- compromiso sin anular dinero real.
--
-- Cambios (solo AÑADE una función y dos triggers; ninguna columna, índice ni
-- dato cambia):
--   dx_payment_void_guard()   BEFORE INSERT | UPDATE | DELETE en `payments`:
--                      - UPDATE o DELETE de una fila con "voidedAt" no nulo:
--                        rechazado, sea cual sea la columna. La transición
--                        vigente -> anulada (OLD."voidedAt" IS NULL) sigue
--                        siendo la anulación de siempre y escribe lo que
--                        quiera (deletedAt, voidedAt, voidedById, voidReason).
--                      - INSERT con "voidedAt" no nulo: rechazado (un abono
--                        nace vigente; si no, se fingiría una anulación por
--                        INSERT en la misma transacción).
--                      - El superusuario pasa (purga administrativa, réplica y
--                        fixtures de test), como en el resto de las tablas
--                        financieras (dx_cash_is_superuser, DX-027).
--
-- Consecuencia para DX-215: desde ahora una fila de `payments` con "voidedAt"
-- no nulo y xmin = la transacción actual SOLO puede ser la que acaba de
-- anularse en esta transacción (no se puede reescribir una anulada ni insertar
-- una ya anulada), así que el predicado `p.xmin = pg_current_xact_id()` de
-- `dx_payment_promise_guard()` pasa a significar «voidedAt cambiado por esta
-- transacción» sin tocar esa función ni depender de un valor de sesión que la
-- app pudiera falsear.
--
-- Columnas escritas legítimamente DESPUÉS de anular: ninguna. La anulación de
-- la API (PrismaPaymentRepository.voidLine) escribe todo en un único UPDATE
-- ... WHERE deletedAt IS NULL; el número de factura externa, el congelado de
-- tasa y los barridos filtran deletedAt IS NULL; comprobante (DX-389),
-- imputaciones/bases (DX-399/413) y recibos viven en otras tablas.
--
-- Bloqueos: CREATE TRIGGER toma SHARE ROW EXCLUSIVE en `payments` (frena las
-- escrituras, no las lecturas); lock_timeout acota la espera. search_path fijo
-- con pg_temp al final y catálogo calificado (SEC-032). Sin datos personales
-- en el mensaje.

SET LOCAL lock_timeout = '5s';

CREATE FUNCTION public.dx_payment_void_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
AS $$
BEGIN
  IF public.dx_cash_is_superuser() THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."voidedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'Un abono no puede registrarse ya como abono anulado: nace vigente y solo se anula después (SEC-042)'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."voidedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'Un abono anulado es definitivo: no se puede modificar ni borrar (SEC-042)'
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "payments_void_immutable"
  BEFORE INSERT OR UPDATE OR DELETE ON "payments"
  FOR EACH ROW EXECUTE FUNCTION public.dx_payment_void_guard();
