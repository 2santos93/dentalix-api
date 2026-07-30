-- Catálogos de referencia GLOBALES: moneda, país, ciudad. Igual que
-- exchange_rate_snapshots, NO son de dominio (no pertenecen a un tenant): sin
-- tenantId, sin deletedAt, y SIN Row Level Security -- no hay nada que aislar
-- por tenant. La tasa/lista es la misma para todas las clínicas.

-- CreateTable
CREATE TABLE "currencies" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "symbol" TEXT NOT NULL,
    CONSTRAINT "currencies_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "countries" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    CONSTRAINT "countries_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "cities" (
    "id" SERIAL NOT NULL,
    "countryCode" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "region" TEXT,
    CONSTRAINT "cities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cities_countryCode_name_idx" ON "cities"("countryCode", "name");

-- AddForeignKey
ALTER TABLE "cities" ADD CONSTRAINT "cities_countryCode_fkey" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AlterTable: ubicación estructurada del paciente (opcional). Convive con el
-- campo libre "address". Ambas columnas nullable => sin backfill.
ALTER TABLE "patients" ADD COLUMN "countryCode" TEXT;
ALTER TABLE "patients" ADD COLUMN "cityId" INTEGER;

-- AddForeignKey
ALTER TABLE "patients" ADD CONSTRAINT "patients_countryCode_fkey" FOREIGN KEY ("countryCode") REFERENCES "countries"("code") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "patients" ADD CONSTRAINT "patients_cityId_fkey" FOREIGN KEY ("cityId") REFERENCES "cities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Grants: no se requiere GRANT explícito. Corre con el rol owner "dentalix"
-- (via DIRECT_URL), y ALTER DEFAULT PRIVILEGES ya otorga DML al rol de la app
-- (dentalix_app) sobre toda tabla nueva -- igual que las migraciones previas.
