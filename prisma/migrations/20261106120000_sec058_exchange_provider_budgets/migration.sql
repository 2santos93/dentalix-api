-- SEC-058: el presupuesto de llamadas al proveedor de tasas (SEC-054) pasa de
-- la memoria de cada réplica a la BD, compartido por todas, con cupo por
-- clínica, tope reducido para clínicas nuevas y una reserva para el barrido
-- de reintentos (DX-380). Los topes los decide la API (variables
-- EXCHANGE_PROVIDER_*, README «Cuota del proveedor de tasas»); aquí solo los
-- contadores, en ventanas FIJAS alineadas a la época (con 24 h, el día UTC).
--
-- Cambios:
--   exchange_provider_budget          el contador GLOBAL: una fila
--                                     (scope = 'GLOBAL') con el inicio de su
--                                     ventana y las llamadas en ella. Tabla de
--                                     PLATAFORMA: sin columna de clínica ni
--                                     RLS (no es de ningún tenant).
--                                     dentalix_app NO tiene ningún privilegio
--                                     sobre ella (ni SELECT): no puede leerla,
--                                     ponerla a cero ni borrarla.
--   dx_exchange_provider_spend_global(p_window_start, p_cap)
--                                     la única vía de la app al contador: un
--                                     INSERT … ON CONFLICT DO UPDATE … WHERE
--                                     calls < p_cap RETURNING calls. Suma una
--                                     llamada si cabe (o abre la ventana nueva)
--                                     y devuelve el recuento; NULL si está
--                                     lleno. El candado de fila del ON
--                                     CONFLICT serializa las réplicas: dos
--                                     llamadas a la vez nunca pasan juntas del
--                                     tope. SECURITY DEFINER (corre como el
--                                     owner de la tabla), search_path =
--                                     pg_catalog, pg_temp y nombres
--                                     calificados (SEC-032), EXECUTE revocado
--                                     a PUBLIC y solo para dentalix_app. No
--                                     acepta una ventana de más de un día en el
--                                     futuro (no se puede «adelantar» el
--                                     contador para dejarlo bloqueado).
--   exchange_provider_clinic_budgets  los contadores de cada clínica: PK
--                                     ("tenantId", quota) con quota HOUR (en
--                                     la ventana de clínica), DAY y SWEEP (en
--                                     la global); una fila por cupo que se
--                                     reutiliza al cambiar de ventana, así que
--                                     no crece ni hay que purgarla. RLS FORCE
--                                     por tenant con la política NULLIF de
--                                     siempre: la app solo lee y gasta los de
--                                     la clínica del contexto. SELECT, INSERT
--                                     y UPDATE para la app (sin DELETE ni
--                                     TRUNCATE). FK a tenants ON DELETE
--                                     CASCADE (dato operativo, no historia).
--
-- La API gasta en UNA transacción con app.current_tenant: primero los cupos
-- de la clínica (mismo UPSERT condicional) y después el global; si alguno
-- está lleno, deshace todo (no gasta ninguno). Siempre en ese orden: sin
-- interbloqueos entre réplicas.
--
-- Compatible hacia atrás: dos tablas nuevas y una función nueva. Una réplica
-- anterior no las nombra y sigue con sus contadores en memoria durante el
-- despliegue escalonado. Sin bloqueos sobre tablas existentes salvo la FK
-- (SHARE ROW EXCLUSIVE en tenants un instante; tabla nueva y vacía, no valida
-- filas).

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Contador global (plataforma)
-- ---------------------------------------------------------------------------
CREATE TABLE "exchange_provider_budget" (
    "scope" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "calls" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),

    CONSTRAINT "exchange_provider_budget_pkey" PRIMARY KEY ("scope"),
    CONSTRAINT "exchange_provider_budget_scope_check" CHECK ("scope" = 'GLOBAL'),
    CONSTRAINT "exchange_provider_budget_calls_check" CHECK ("calls" >= 1)
);

-- ALTER DEFAULT PRIVILEGES da a dentalix_app SELECT/INSERT/UPDATE/DELETE en
-- las tablas nuevas: aquí se le quita todo.
REVOKE ALL ON "exchange_provider_budget" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    REVOKE ALL ON "exchange_provider_budget" FROM dentalix_app;
  END IF;
END;
$$;

CREATE FUNCTION dx_exchange_provider_spend_global(
  p_window_start timestamp(3),
  p_cap integer
)
RETURNS integer
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
DECLARE
  v_calls integer;
BEGIN
  IF p_window_start IS NULL OR p_cap IS NULL OR p_cap < 1 THEN
    RETURN NULL;
  END IF;
  IF p_window_start > pg_catalog.timezone('UTC', pg_catalog.now())
                     + pg_catalog.make_interval(days => 1) THEN
    RAISE EXCEPTION 'dx_exchange_provider_spend_global: ventana en el futuro';
  END IF;
  -- Una ventana más nueva que la guardada empieza en 1; una igual (o una
  -- anterior, de una réplica con el reloj algo atrasado) suma en la guardada,
  -- solo si cabe.
  INSERT INTO public."exchange_provider_budget" AS b
    ("scope", "windowStart", "calls")
  VALUES ('GLOBAL', p_window_start, 1)
  ON CONFLICT ("scope") DO UPDATE
     SET "calls" = CASE WHEN EXCLUDED."windowStart" > b."windowStart"
                        THEN 1 ELSE b."calls" + 1 END,
         "windowStart" = GREATEST(b."windowStart", EXCLUDED."windowStart"),
         "updatedAt" = pg_catalog.timezone('UTC', pg_catalog.now())
   WHERE EXCLUDED."windowStart" > b."windowStart" OR b."calls" < p_cap
  RETURNING b."calls" INTO v_calls;
  RETURN v_calls;
END;
$$;

REVOKE ALL ON FUNCTION dx_exchange_provider_spend_global(timestamp(3), integer) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    GRANT EXECUTE ON FUNCTION dx_exchange_provider_spend_global(timestamp(3), integer) TO dentalix_app;
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. Contadores de cada clínica
-- ---------------------------------------------------------------------------
CREATE TABLE "exchange_provider_clinic_budgets" (
    "tenantId" UUID NOT NULL,
    "quota" TEXT NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "calls" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),

    CONSTRAINT "exchange_provider_clinic_budgets_pkey" PRIMARY KEY ("tenantId", "quota"),
    CONSTRAINT "exchange_provider_clinic_budgets_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id")
      ON DELETE CASCADE ON UPDATE RESTRICT,
    CONSTRAINT "exchange_provider_clinic_budgets_quota_check"
      CHECK ("quota" IN ('HOUR', 'DAY', 'SWEEP')),
    CONSTRAINT "exchange_provider_clinic_budgets_calls_check" CHECK ("calls" >= 1)
);

REVOKE ALL ON "exchange_provider_clinic_budgets" FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dentalix_app') THEN
    REVOKE ALL ON "exchange_provider_clinic_budgets" FROM dentalix_app;
    GRANT SELECT, INSERT, UPDATE ON "exchange_provider_clinic_budgets" TO dentalix_app;
  END IF;
END;
$$;

ALTER TABLE "exchange_provider_clinic_budgets" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "exchange_provider_clinic_budgets"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "exchange_provider_clinic_budgets" FORCE ROW LEVEL SECURITY;
