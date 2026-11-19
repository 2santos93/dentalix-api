import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaClinicalEntryRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry.repository';
import { PrismaClinicalEntrySettingsRepository } from '../src/modules/clinical-entries/infrastructure/repositories/prisma-clinical-entry-settings.repository';
import { CreateClinicalEntryUseCase } from '../src/modules/clinical-entries/application/use-cases/create-clinical-entry.use-case';
import { PrismaMedicalHistoryRepository } from '../src/modules/medical-history/infrastructure/repositories/prisma-medical-history.repository';
import { SaveMedicalHistoryUseCase } from '../src/modules/medical-history/application/use-cases/save-medical-history.use-case';
import { InMemoryClinicalNoteTemplateRepository } from '../src/modules/clinical-note-templates/application/__fixtures__/in-memory-clinical-note-templates';
import { patientsInClinic } from '../src/modules/patients/application/__fixtures__/patients-in-clinic.fake';
import type { IdempotencySignals } from '../src/shared/validation/idempotent-create';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';

// DX-574, capa BD de las altas idempotentes por la MISMA ruta que la app
// (runWithTenant, rol dentalix_app, RLS FORCE): dos (o más) envíos A LA VEZ
// con la misma Idempotency-Key dejan UN registro y todos devuelven el mismo;
// el único parcial es por clínica (la misma clave en otra clínica escribe la
// suya y no ve la ajena); y una clave nunca se puede cambiar después (las
// evoluciones son inalterables, DX-038).

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const SUBDOMAINS = ['dx574-int-a', 'dx574-int-b'];

interface Clinic {
  tenantId: string;
  locationId: string;
  patientId: string;
}

describe('DX-574 · Idempotency-Key de las altas clínicas en la BD (int)', () => {
  const context = new TenantContextService();
  const prisma = new PrismaService(context);
  const entries = new PrismaClinicalEntryRepository(prisma, context);
  const histories = new PrismaMedicalHistoryRepository(prisma, context);
  let a: Clinic;
  let b: Clinic;
  let authorId: string;

  const entryUseCase = (c: Clinic) =>
    new CreateClinicalEntryUseCase(
      entries,
      patientsInClinic(c.patientId),
      new InMemoryClinicalNoteTemplateRepository(),
      context,
      new PrismaClinicalEntrySettingsRepository(prisma, context),
    );

  async function seedClinic(subdomain: string): Promise<Clinic> {
    const tenant = await raw.tenant.create({
      data: { name: subdomain, subdomain },
    });
    const location = await raw.location.create({
      data: locationData(REGIONAL_CARACAS_FIXTURE, {
        tenantId: tenant.id,
        name: 'Principal',
      }),
    });
    const patient = await raw.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Luis',
        lastName: 'Pérez',
        docNumber: `V-${subdomain}`,
      },
    });
    return {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
    };
  }

  const inClinic = <T>(c: Clinic, fn: () => Promise<T>) =>
    context.run(c.tenantId, c.locationId, fn);

  beforeAll(async () => {
    await prisma.onModuleInit();
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    a = await seedClinic(SUBDOMAINS[0]);
    b = await seedClinic(SUBDOMAINS[1]);
    authorId = (
      await raw.user.create({
        data: {
          email: `dx574-${randomUUID()}@example.com`,
          fullName: 'Dra. Carmen Silva',
          passwordHash: 'not-used',
        },
      })
    ).id;
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, SUBDOMAINS);
    await raw.user.delete({ where: { id: authorId } });
    await prisma.onModuleDestroy();
    await raw.$disconnect();
  });

  it('evolución: cuatro envíos a la vez con la misma clave dejan una fila y devuelven la misma', async () => {
    const key = randomUUID();
    const uc = entryUseCase(a);
    const signals: IdempotencySignals[] = [{}, {}, {}, {}];
    const results = await Promise.all(
      signals.map((s) =>
        inClinic(a, () =>
          uc.execute(
            a.patientId,
            { notes: 'Endodoncia 46, primera sesión' },
            authorId,
            undefined,
            undefined,
            { idempotencyKey: key, signals: s },
          ),
        ),
      ),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(signals.filter((s) => !s.replayed)).toHaveLength(1);
    expect(
      await raw.clinicalEntry.count({
        where: { tenantId: a.tenantId, idempotencyKey: key },
      }),
    ).toBe(1);
  });

  it('anamnesis: cuatro guardados a la vez con la misma clave dejan una versión', async () => {
    const key = randomUUID();
    const uc = new SaveMedicalHistoryUseCase(
      histories,
      patientsInClinic(a.patientId),
    );
    const before = await raw.medicalHistoryVersion.count({
      where: { patientId: a.patientId },
    });
    const results = await Promise.all(
      [0, 1, 2, 3].map(() =>
        inClinic(a, () =>
          uc.execute(
            a.patientId,
            { notes: 'Diabetes tipo 2 controlada' },
            authorId,
            { idempotencyKey: key },
          ),
        ),
      ),
    );

    expect(new Set(results.map((r) => r.id)).size).toBe(1);
    expect(
      await raw.medicalHistoryVersion.count({
        where: { patientId: a.patientId },
      }),
    ).toBe(before + 1);
  });

  it('la clave es por clínica: la misma en otra clínica escribe la suya y no ve la ajena', async () => {
    const key = randomUUID();
    const mine = await inClinic(a, () =>
      entryUseCase(a).execute(
        a.patientId,
        { notes: 'Control' },
        authorId,
        undefined,
        undefined,
        { idempotencyKey: key },
      ),
    );
    const theirs = await inClinic(b, () =>
      entryUseCase(b).execute(
        b.patientId,
        { notes: 'Control' },
        authorId,
        undefined,
        undefined,
        { idempotencyKey: key },
      ),
    );
    expect(theirs.id).not.toBe(mine.id);
    const seenFromB = await inClinic(b, () =>
      entries.findByIdempotencyKey(key),
    );
    expect(seenFromB?.value.id).toBe(theirs.id);
  });

  it('el único parcial existe en las cinco tablas y la clave de una evolución no cambia (DX-038)', async () => {
    const indexes = await raw.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
       WHERE indexname LIKE '%_tenant_idempotency_key'
         AND tablename IN ('clinical_entries', 'medical_history_versions',
           'treatment_plans', 'treatment_plan_items', 'prescriptions')
         AND indexdef LIKE '%WHERE ("idempotencyKey" IS NOT NULL)%'`;
    expect(indexes).toHaveLength(5);

    const key = randomUUID();
    const entry = await inClinic(a, () =>
      entryUseCase(a).execute(
        a.patientId,
        { notes: 'Inalterable' },
        authorId,
        undefined,
        undefined,
        { idempotencyKey: key },
      ),
    );
    await expect(
      raw.clinicalEntry.update({
        where: { id: entry.id },
        data: { idempotencyKey: randomUUID() },
      }),
    ).rejects.toThrow();
  });
});
