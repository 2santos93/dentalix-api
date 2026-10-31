import { Prisma, PrismaClient } from '@prisma/client';
import { seedIcd10Codes } from '../src/modules/reference/infrastructure/seed-icd10-codes';
import { loadCitySeedRows } from './reference/cities';
import { ISO3166_COUNTRIES } from './reference/iso3166';
import { ISO4217_CURRENCIES } from './reference/iso4217';

// Corre con el rol owner (DIRECT_URL): estas tablas son globales, sin RLS.
const prisma = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

// GLOBAL-G1 (DX-313): lista ISO 4217 vigente (sin fondos, metales, monedas
// de 3 decimales ni códigos retirados), generada por
// prisma/scripts/generate-iso4217-sql.ts. La misma lista se siembra en la
// migración 20261027120000_g1_location_regional_settings, así que existe con
// solo `prisma migrate deploy`; el upsert de abajo permite actualizar
// name/symbol sin una migración nueva. A propósito: la migración inserta con
// `ON CONFLICT DO NOTHING`, así que en una base solo migrada las 10 monedas de
// 2026-07 (USD, EUR, MXN…) conservan su nombre y símbolo de entonces, y el
// seed los cambia por los de `Intl`. Solo es texto de presentación: el código
// y los decimales no cambian.
async function seedCurrencies(): Promise<void> {
  for (const { code, name, symbol } of ISO4217_CURRENCIES) {
    await prisma.currency.upsert({
      where: { code },
      update: { name, symbol },
      create: { code, name, symbol },
    });
  }
  console.log(`Seeded ${ISO4217_CURRENCIES.length} currencies`);
}

// DX-312: lista ISO 3166-1 con nombres en español, generada por
// prisma/scripts/generate-iso3166.ts. La migración
// 20261031120000_dx312_location_country_code siembra la misma lista con
// `ON CONFLICT DO UPDATE`, así que existe con solo `prisma migrate deploy`.
// Las filas que ya hubiera y no estén en la lista se quedan.
async function seedCountries(): Promise<void> {
  for (const { code, name } of ISO3166_COUNTRIES) {
    await prisma.country.upsert({
      where: { code },
      update: { name },
      create: { code, name },
    });
  }
  console.log(`Seeded ${ISO3166_COUNTRIES.length} countries`);
}

async function seedCities(): Promise<void> {
  // Idempotencia + estabilidad de FKs: si ya hay ciudades, no re-sembrar
  // (los ids autoincrement no deben cambiar bajo pacientes que los referencian).
  const existing = await prisma.city.count();
  if (existing > 0) {
    console.log(`Cities already seeded (${existing}); skipping`);
    return;
  }
  // En la imagen de runtime, del JSON que deja build:scripts (DX-083); en
  // desarrollo, de country-state-city. Agrupadas por país, como siempre.
  const data = loadCitySeedRows();
  let total = 0;
  // Lotes para no exceder límites de parámetros.
  for (let i = 0; i < data.length; i += 5000) {
    const batch = data.slice(i, i + 5000);
    await prisma.city.createMany({ data: batch });
    total += batch.length;
  }
  console.log(`Seeded ${total} cities`);
}

// DX-212: CIE-10 del capítulo oral (K00–K14 y Z01.2), upsert por código.
async function seedIcd10(): Promise<void> {
  const total = await seedIcd10Codes(prisma);
  console.log(`Seeded ${total} ICD-10 codes`);
}

async function main(): Promise<void> {
  await seedCurrencies();
  await seedCountries();
  await seedCities();
  await seedIcd10();
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => {
    void prisma.$disconnect();
  });
