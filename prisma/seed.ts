import { Prisma, PrismaClient } from '@prisma/client';
import { Country, State, City } from 'country-state-city';
import { seedIcd10Codes } from '../src/modules/reference/infrastructure/seed-icd10-codes';
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
// name/symbol sin una migración nueva.
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

async function seedCountries(): Promise<void> {
  const countries = Country.getAllCountries();
  for (const c of countries) {
    await prisma.country.upsert({
      where: { code: c.isoCode },
      update: { name: c.name },
      create: { code: c.isoCode, name: c.name },
    });
  }
  console.log(`Seeded ${countries.length} countries`);
}

async function seedCities(): Promise<void> {
  // Idempotencia + estabilidad de FKs: si ya hay ciudades, no re-sembrar
  // (los ids autoincrement no deben cambiar bajo pacientes que los referencian).
  const existing = await prisma.city.count();
  if (existing > 0) {
    console.log(`Cities already seeded (${existing}); skipping`);
    return;
  }
  const countries = Country.getAllCountries();
  let total = 0;
  for (const country of countries) {
    // Mapa stateCode -> nombre para poblar `region` (informativo).
    const stateName = new Map(
      State.getStatesOfCountry(country.isoCode).map((s) => [s.isoCode, s.name]),
    );
    const cities = City.getCitiesOfCountry(country.isoCode) ?? [];
    if (cities.length === 0) continue;
    const data = cities.map((city) => ({
      countryCode: country.isoCode,
      name: city.name,
      region: city.stateCode ? (stateName.get(city.stateCode) ?? null) : null,
    }));
    // Lotes para no exceder límites de parámetros.
    for (let i = 0; i < data.length; i += 5000) {
      const batch = data.slice(i, i + 5000);
      await prisma.city.createMany({ data: batch });
      total += batch.length;
    }
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
