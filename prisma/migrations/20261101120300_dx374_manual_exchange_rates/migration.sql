-- DX-374 (porción 1 de DX-367): tasas de cambio manuales de cada clínica. Con
-- la fuente MANUAL (`tenants."exchangeRateSource"`), la tasa de un día sale de
-- aquí y no del proveedor; sin fila para ese día y moneda, la moneda queda
-- «sin tasa» (no se inventa ni se pide al proveedor).
--
-- Cambios:
--   manual_exchange_rates   una tasa por clínica, día civil y moneda, en
--                           unidades de la moneda por 1 USD (la misma base que
--                           `exchange_rate_snapshots`), con su autor y la hora
--                           de alta.
--
-- Reglas en la BD:
--   * Única por ("tenantId", "date", "currency"): una tasa ya registrada no se
--     sobrescribe (la API responde 409). El índice sirve además la lectura de
--     un día y la lista de las últimas (recorrido hacia atrás), así que no hay
--     índice aparte por ("tenantId", "date").
--   * La app solo tiene SELECT e INSERT: corregir una tasa llega con DX-375
--     (porción 2), que decidirá cómo y bloqueará la de un abono ya cobrado.
--   * FK de clínica (ON DELETE CASCADE: configuración de la clínica, como
--     location_working_calendars), FK a `currencies` (RESTRICT) y FK
--     COMPUESTA del autor ("tenantId", "createdByMembershipId",
--     "createdById") → clinic_memberships("tenantId", "id", "userId"), como la
--     atribución de DX-050: el autor es miembro de la MISMA clínica. RESTRICT:
--     las membresías se retiran en blando, nunca en duro.
--   * Tasa > 0 (Decimal(18,8): hasta 8 decimales); moneda distinta de USD (es
--     la base, su tasa siempre es 1); día entre 2000-01-01 y 2100-12-31
--     (PERIOD_DAY_MIN/MAX). Que el día no sea futuro en la zona de la sede lo
--     comprueba la API: la BD no sabe la zona.
--   * "createdAt" lo pone la BD en UTC (DX-226), no el reloj de la API.
--   * RLS FORCE por tenant con la política NULLIF de siempre.
--
-- Compatible hacia atrás: solo AÑADE una tabla vacía y sus índices. El código
-- anterior no la conoce.
--
-- Bloqueos: las FK toman SHARE ROW EXCLUSIVE en `tenants`, `currencies` y
-- `clinic_memberships` hasta el COMMIT (no choca con las lecturas ni con las
-- comprobaciones de FK; solo frena escrituras en esas tablas mientras dura).
-- Tabla nueva y vacía: las FK no validan filas, así que no hace falta el
-- bracket NO FORCE/FORCE de DX-134. lock_timeout 5 s: si una transacción
-- larga las retiene, falla limpia. Prisma la deja marcada como fallida (otro
-- `migrate deploy` se para con P3009): se ejecuta `npx prisma migrate resolve
-- --rolled-back 20261101120300_dx374_manual_exchange_rates` y se repite
-- `migrate deploy`.

SET LOCAL lock_timeout = '5s';

CREATE TABLE "manual_exchange_rates" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "date" DATE NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(18,8) NOT NULL,
    "createdById" UUID NOT NULL,
    "createdByMembershipId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT timezone('UTC', now()),

    CONSTRAINT "manual_exchange_rates_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "manual_exchange_rates_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "manual_exchange_rates_currency_fkey"
      FOREIGN KEY ("currency") REFERENCES "currencies"("code") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "manual_exchange_rates_created_by_fkey"
      FOREIGN KEY ("tenantId", "createdByMembershipId", "createdById")
      REFERENCES "clinic_memberships"("tenantId", "id", "userId")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "manual_exchange_rates_rate_check" CHECK ("rate" > 0),
    CONSTRAINT "manual_exchange_rates_currency_check" CHECK ("currency" <> 'USD'),
    CONSTRAINT "manual_exchange_rates_date_check"
      CHECK ("date" BETWEEN DATE '2000-01-01' AND DATE '2100-12-31')
);

-- Una tasa por clínica, día y moneda (y lectura por clínica y día).
CREATE UNIQUE INDEX "manual_exchange_rates_tenant_date_currency_key"
  ON "manual_exchange_rates"("tenantId", "date", "currency");
-- Lado hijo de la FK compuesta del autor.
CREATE INDEX "manual_exchange_rates_created_by_idx"
  ON "manual_exchange_rates"("tenantId", "createdByMembershipId", "createdById");

-- La app inserta y lee; los privilegios por defecto le dan además UPDATE y
-- DELETE: se quitan (una tasa registrada no se sobrescribe).
GRANT SELECT, INSERT ON "manual_exchange_rates" TO dentalix_app;
REVOKE UPDATE, DELETE, TRUNCATE ON "manual_exchange_rates" FROM dentalix_app;

ALTER TABLE "manual_exchange_rates" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "manual_exchange_rates"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "manual_exchange_rates" FORCE ROW LEVEL SECURITY;
