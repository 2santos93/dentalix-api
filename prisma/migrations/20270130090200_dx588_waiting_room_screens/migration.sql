-- DX-588: pantalla de sala de espera (el televisor) y turno del día.
--
-- Cambios (todos ADITIVOS):
--   "WaitingRoomNameMode"     enum: NAME_INITIAL («Ana R.», por defecto) o
--                             TURN_NUMBER («Turno 7», ningún nombre).
--   waiting_room_screens      pantalla de una sede: nombre (1–60, sin espacios
--                             en los extremos ni caracteres de control), SHA-256
--                             del token (el token solo viaja en el enlace;
--                             único en TODA la BD), modo de nombre, mensajes
--                             rotativos (0–5 de 1–140) y aviso sonoro. No se
--                             borra: se revoca (sin DELETE para dentalix_app).
--   location_turn_counters    último turno dado en una sede un día civil (zona
--                             de la sede). La app lo sube con INSERT … ON
--                             CONFLICT DO UPDATE … RETURNING al marcar «Llegó»,
--                             en la misma transacción: dos recepciones a la vez
--                             no comparten número. Sin DELETE para la app.
--   appointments."turnNumber" INT NULL: el turno asignado al llegar. NULL en
--                             las citas que no han llegado y en las anteriores.
--
-- Reglas en la BD (la API responde antes con 400/404/409 en español):
--   * FK directa a tenants ON DELETE RESTRICT y FK COMPUESTA (tenantId,
--     locationId) → locations en las dos tablas nuevas, dentro del CREATE
--     TABLE (nacen vacías, DX-134): la sede es de la MISMA clínica.
--   * revokedAt y revokedById van juntos; mensajes sin NULL, como mucho 5 y
--     ninguno vacío ni de más de 140 (la longitud total acota cada uno junto
--     con la API; la API valida cada mensaje).
--   * RLS FORCE por tenant en las dos tablas, con NULLIF como el resto.
--
-- Bloqueo: CREATE TABLE de tablas nuevas; en `appointments`, ADD COLUMN sin
-- DEFAULT es solo catálogo (ACCESS EXCLUSIVE de milisegundos). lock_timeout
-- evita quedar encolado detrás de una transacción larga.
--
-- Compatible hacia atrás: tablas nuevas y una columna NULL que el código
-- anterior no lee ni escribe.
--
-- Vuelta atrás: ALTER TABLE "appointments" DROP COLUMN "turnNumber";
-- DROP TABLE "location_turn_counters", "waiting_room_screens";
-- DROP TYPE "WaitingRoomNameMode".

SET LOCAL lock_timeout = '5s';

CREATE TYPE "WaitingRoomNameMode" AS ENUM ('NAME_INITIAL', 'TURN_NUMBER');

-- ---------------------------------------------------------------------------
-- 1. Pantallas
-- ---------------------------------------------------------------------------
CREATE TABLE "waiting_room_screens" (
    "id" UUID NOT NULL,
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "tokenHash" CHAR(64) NOT NULL,
    "nameMode" "WaitingRoomNameMode" NOT NULL DEFAULT 'NAME_INITIAL',
    "messages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "soundEnabled" BOOLEAN NOT NULL DEFAULT false,
    "revokedAt" TIMESTAMP(3),
    "revokedById" UUID,
    "createdById" UUID,
    "updatedById" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "waiting_room_screens_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "waiting_room_screens_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    -- FK COMPUESTA: la sede es de la MISMA clínica.
    CONSTRAINT "waiting_room_screens_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "waiting_room_screens_name_check" CHECK (
      "name" = btrim("name")
      AND char_length("name") BETWEEN 1 AND 60
      AND "name" !~ '[[:cntrl:]]'
    ),
    CONSTRAINT "waiting_room_screens_token_hash_check" CHECK ("tokenHash" ~ '^[0-9a-f]{64}$'),
    CONSTRAINT "waiting_room_screens_messages_check" CHECK (
      "messages" IS NOT NULL
      AND cardinality("messages") <= 5
      AND array_position("messages", NULL) IS NULL
      AND array_position("messages", '') IS NULL
      AND char_length(array_to_string("messages", '')) <= 700
    ),
    CONSTRAINT "waiting_room_screens_revoked_check" CHECK (
      "revokedById" IS NULL OR "revokedAt" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "waiting_room_screens_token_hash_key" ON "waiting_room_screens"("tokenHash");
-- Lado hijo de la FK a la sede y la lista por sede de Ajustes.
CREATE INDEX "waiting_room_screens_location_idx" ON "waiting_room_screens"("tenantId", "locationId");

-- ---------------------------------------------------------------------------
-- 2. Contador de turnos del día por sede
-- ---------------------------------------------------------------------------
CREATE TABLE "location_turn_counters" (
    "tenantId" UUID NOT NULL,
    "locationId" UUID NOT NULL,
    "day" DATE NOT NULL,
    "lastNumber" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "location_turn_counters_pkey" PRIMARY KEY ("tenantId", "locationId", "day"),
    CONSTRAINT "location_turn_counters_tenantId_fkey"
      FOREIGN KEY ("tenantId") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_turn_counters_tenantId_locationId_fkey"
      FOREIGN KEY ("tenantId", "locationId") REFERENCES "locations"("tenantId", "id")
      ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "location_turn_counters_last_number_check" CHECK ("lastNumber" >= 1)
);

-- ---------------------------------------------------------------------------
-- 3. El turno de la cita
-- ---------------------------------------------------------------------------
ALTER TABLE "appointments" ADD COLUMN "turnNumber" INTEGER;

-- ---------------------------------------------------------------------------
-- 4. RLS y permisos
-- ---------------------------------------------------------------------------
ALTER TABLE "waiting_room_screens" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "waiting_room_screens" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "waiting_room_screens"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

ALTER TABLE "location_turn_counters" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "location_turn_counters" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "location_turn_counters"
  USING ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid)
  WITH CHECK ("tenantId" = NULLIF(current_setting('app.current_tenant', true), '')::uuid);

-- Revocar en lugar de borrar; el contador solo sube.
GRANT SELECT, INSERT, UPDATE ON "waiting_room_screens" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "waiting_room_screens" FROM dentalix_app;
GRANT SELECT, INSERT, UPDATE ON "location_turn_counters" TO dentalix_app;
REVOKE DELETE, TRUNCATE ON "location_turn_counters" FROM dentalix_app;
