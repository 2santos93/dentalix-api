import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-036 / DB-003, capa DB: las EXCLUDE constraints se evalúan SALTANDO la RLS.
// Sin `"tenantId" WITH =`, una cita del tenant B chocaba con la del mismo
// `providerId` en el tenant A (canal lateral + bloqueo de agenda entre
// clínicas). Este spec inserta por SQL directo (owner, sin RLS) para probar la
// constraint en sí, sin el pre-check de la aplicación delante.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PROVIDER_ID = randomUUID();
const START = new Date('2031-03-03T10:00:00.000Z');
const END = new Date('2031-03-03T10:30:00.000Z');

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
}

async function seedClinic(subdomain: string): Promise<Clinic> {
  const tenant = await raw.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await raw.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede',
    }),
  });
  const patient = await raw.patient.create({
    data: { tenantId: tenant.id, firstName: 'Ana', lastName: subdomain },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
  };
}

function insertAppointment(
  clinic: Clinic,
  opts: { providerId: string; patientId?: string },
) {
  return raw.appointment.create({
    data: {
      tenantId: clinic.tenantId,
      locationId: clinic.locationId,
      patientId: opts.patientId ?? clinic.patientId,
      providerId: opts.providerId,
      start: START,
      end: END,
    },
  });
}

const SUBDOMAINS = ['dx036-a', 'dx036-b'];

// Limpieza acotada a los tenants de este spec: no toca datos de otras suites.
async function cleanup(): Promise<void> {
  const tenants = await raw.tenant.findMany({
    where: { subdomain: { in: SUBDOMAINS } },
    select: { id: true },
  });
  const where = { tenantId: { in: tenants.map((t) => t.id) } };
  await raw.appointment.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.tenant.deleteMany({ where: { id: where.tenantId } });
}

describe('EXCLUDE anti-solape de citas por tenant (int, DX-036)', () => {
  let clinicA: Clinic;
  let clinicB: Clinic;

  beforeAll(async () => {
    await cleanup();
    clinicA = await seedClinic(SUBDOMAINS[0]);
    clinicB = await seedClinic(SUBDOMAINS[1]);
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
  });

  it.each([
    'appointments_no_overlap_per_provider',
    'appointments_no_overlap_per_patient',
  ])('%s incluye "tenantId" WITH = y conserva rango y filtro', async (name) => {
    const rows = await raw.$queryRaw<{ def: string }[]>`
      SELECT pg_get_constraintdef(oid) AS def
      FROM pg_constraint
      WHERE conname = ${name} AND conrelid = '"appointments"'::regclass`;
    expect(rows).toHaveLength(1);
    const def = rows[0].def;
    expect(def).toContain('"tenantId" WITH =');
    expect(def).toContain('tsrange(start, "end") WITH &&');
    expect(def).toContain('"deletedAt" IS NULL');
    expect(def).toContain("'CANCELLED'");
  });

  it('mismo profesional y misma franja en clínicas distintas: ambas filas se insertan', async () => {
    await insertAppointment(clinicA, { providerId: PROVIDER_ID });
    await expect(
      insertAppointment(clinicB, { providerId: PROVIDER_ID }),
    ).resolves.toMatchObject({ tenantId: clinicB.tenantId });
  });

  it('mismo profesional y misma franja en la misma clínica: 23P01 por profesional', async () => {
    const otherPatient = await raw.patient.create({
      data: { tenantId: clinicA.tenantId, firstName: 'Luis', lastName: 'A' },
    });
    await expect(
      insertAppointment(clinicA, {
        providerId: PROVIDER_ID,
        patientId: otherPatient.id,
      }),
    ).rejects.toThrow(/appointments_no_overlap_per_provider/);
  });

  it('mismo paciente y misma franja en la misma clínica: 23P01 por paciente', async () => {
    await expect(
      insertAppointment(clinicA, { providerId: randomUUID() }),
    ).rejects.toThrow(/appointments_no_overlap_per_patient/);
  });
});
