import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaClinicRetentionSettingsRepository } from '../src/modules/patients/infrastructure/repositories/prisma-clinic-retention-settings.repository';
import { purgeTenants } from './support/tenant-purge';

// DX-330 (spec §9, PF2): cuánto tarda el UPDATE de R6 con una clínica grande.
// El tiempo va al ledger; decidir lotes no es de esta prueba.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const PATIENTS = 20_000;
const BATCH = 2_000;
const LOAD_TIMEOUT_MS = 120_000;
const SUFFIX = `${process.pid}-${Date.now()}`;

describe('tiempo de R6 (DX-330, int)', () => {
  let clinic: string;
  let actorId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    actorId = (
      await raw.user.create({
        data: {
          email: `dx330-load-${SUFFIX}@example.com`,
          passwordHash: 'x',
          fullName: 'Dra. Plazo',
        },
      })
    ).id;
    clinic = (
      await raw.tenant.create({
        data: {
          name: 'dx330-load',
          subdomain: `dx330-load-${SUFFIX}`,
          clinicalRecordRetentionYears: 25,
        },
      })
    ).id;
    for (let done = 0; done < PATIENTS; done += BATCH) {
      await raw.patient.createMany({
        data: Array.from({ length: BATCH }, () => ({
          id: randomUUID(),
          tenantId: clinic,
          firstName: 'Carga',
          lastName: 'DX330',
          lastAttentionAt: new Date('2010-06-15T10:00:00Z'),
        })),
      });
    }
  }, LOAD_TIMEOUT_MS);

  afterAll(async () => {
    await purgeTenants(raw, [clinic]);
    await raw.user.delete({ where: { id: actorId } });
    await raw.$disconnect();
    await prisma.$disconnect();
  }, LOAD_TIMEOUT_MS);

  it(
    'measures R6 with 20 000 patients',
    async () => {
      const repo = new PrismaClinicRetentionSettingsRepository(
        prisma,
        tenantContext,
        { platformMinYears: 15 },
      );

      const started = Date.now();
      const result = await tenantContext.run(clinic, () =>
        repo.set(
          { clinicalRecordRetentionYears: 15, confirmReduction: true },
          {
            tenantId: clinic,
            locationId: null,
            actor: { userId: actorId, role: 'ADMIN' },
            requestId: null,
            ip: null,
            userAgent: null,
          },
          new Date('2026-11-01T12:00:00Z'),
        ),
      );
      const ms = Date.now() - started;

      console.log(JSON.stringify({ patients: PATIENTS, ms }));
      expect(result).toMatchObject({
        outcome: 'APPLIED',
        protectedPatients: PATIENTS,
      });
    },
    LOAD_TIMEOUT_MS,
  );
});
