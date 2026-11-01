import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaAuthRepository } from '../src/modules/auth/infrastructure/repositories/prisma-auth.repository';
import { REGIONAL_BOGOTA_FIXTURE } from './support/location-fixtures';

// DX-330: el plazo de conservación de la HC es una columna de la clínica
// (`clinicalRecordRetentionYears`, CHECK 15..100) con su ventana de corrección
// (`RaisedAt` + `YearsBeforeRaise`, CHECK de media ventana). Esta capa DB
// comprueba el alta de la clínica con el mínimo de plataforma y los dos CHECK,
// por la misma ruta que la app (rol dentalix_app) y con el owner (`raw`).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const SUFFIX = `${process.pid}-${Date.now()}`;
let tenantA: string;
let tenantB: string;
const created: { tenantId: string; userId: string }[] = [];

function termOf(tenantId: string): Promise<number> {
  return raw.tenant
    .findUniqueOrThrow({
      where: { id: tenantId },
      select: { clinicalRecordRetentionYears: true },
    })
    .then((t) => t.clinicalRecordRetentionYears);
}

describe('plazo de conservación de la HC por clínica (DX-330, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    tenantA = (
      await raw.tenant.create({
        data: { name: 'dx330-a', subdomain: `dx330-t1-a-${SUFFIX}` },
      })
    ).id;
    tenantB = (
      await raw.tenant.create({
        data: { name: 'dx330-b', subdomain: `dx330-t1-b-${SUFFIX}` },
      })
    ).id;
  });

  afterAll(async () => {
    await raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('a new clinic starts at the platform minimum', async () => {
    const repo = new PrismaAuthRepository(prisma, { platformMinYears: 20 });
    const clinic = await repo.createClinicWithOwner({
      clinicName: 'dx330 alta',
      subdomain: `dx330-t1-alta-${SUFFIX}`,
      email: `dx330-t1-${SUFFIX}@example.com`,
      passwordHash: 'x',
      fullName: 'Dra. Plazo',
      emailVerifiedAt: new Date('2026-11-01T12:00:00Z'),
      location: {
        country: REGIONAL_BOGOTA_FIXTURE.country,
        currency: REGIONAL_BOGOTA_FIXTURE.currency,
        timeZone: REGIONAL_BOGOTA_FIXTURE.timeZone,
        locale: REGIONAL_BOGOTA_FIXTURE.locale,
        hourCycle: REGIONAL_BOGOTA_FIXTURE.hourCycle,
      },
      request: null,
    });
    created.push(clinic);
    expect(await termOf(clinic.tenantId)).toBe(20);
    // Las clínicas anteriores no cambian: el default de la BD es el suelo.
    expect(await termOf(tenantA)).toBe(15);
    expect(await termOf(tenantB)).toBe(15);
  });

  it('the database rejects a term outside 15..100 and a half-open window', async () => {
    const setTerm = (id: string, years: number) =>
      raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = ${years} WHERE "id" = ${id}::uuid`;
    await expect(setTerm(tenantA, 14)).rejects.toThrow(
      /tenants_clinical_record_retention_years_check/,
    );
    await expect(setTerm(tenantA, 101)).rejects.toThrow(
      /tenants_clinical_record_retention_years_check/,
    );
    await expect(
      raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionRaisedAt" = now() WHERE "id" = ${tenantA}::uuid`,
    ).rejects.toThrow(/tenants_clinical_record_retention_raise_check/);
    await expect(
      raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYearsBeforeRaise" = 15 WHERE "id" = ${tenantA}::uuid`,
    ).rejects.toThrow(/tenants_clinical_record_retention_raise_check/);
    // Los extremos y una ventana completa sí entran.
    await setTerm(tenantA, 100);
    await raw.$executeRaw`UPDATE "tenants" SET "clinicalRecordRetentionYears" = 20, "clinicalRecordRetentionRaisedAt" = now(), "clinicalRecordRetentionYearsBeforeRaise" = 15 WHERE "id" = ${tenantA}::uuid`;
    expect(await termOf(tenantA)).toBe(20);
  });
});
