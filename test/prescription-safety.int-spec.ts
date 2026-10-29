import { ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaDocumentTypeNamesRepository } from '../src/modules/patients/infrastructure/repositories/prisma-document-type-names.repository';
import { PrismaPrescriptionRepository } from '../src/modules/prescriptions/infrastructure/repositories/prisma-prescription.repository';
import {
  CheckPrescriptionSafetyUseCase,
  GetPrescriptionUseCase,
  IssuePrescriptionUseCase,
} from '../src/modules/prescriptions/application/use-cases/prescriptions.use-cases';
import { computePrescriptionHash } from '../src/modules/prescriptions/domain/prescription-hash';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-300, receta segura con Postgres real: el caso de uso de emisión lee la
// anamnesis VIGENTE por el repositorio de la app (runWithTenant, rol
// dentalix_app, RLS); `raw` (owner) solo siembra y limpia.
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaPrescriptionRepository(prisma, tenantContext);
const NOW = () => new Date();

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
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
    data: {
      tenantId: tenant.id,
      firstName: 'Ana',
      lastName: subdomain,
      docNumber: `DOC-${subdomain}`,
      birthDate: new Date('1980-05-04T00:00:00.000Z'),
    },
  });
  const user = await raw.user.create({
    data: {
      email: `dr@${subdomain}.test`,
      passwordHash: 'x',
      fullName: 'Dra. Prueba',
    },
  });
  await raw.clinicMembership.create({
    data: {
      tenantId: tenant.id,
      userId: user.id,
      role: 'DENTIST',
      professionalLicense: 'RM-1',
    },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: patient.id,
    userId: user.id,
  };
}

const SUBDOMAINS = ['rxs-int-a', 'rxs-int-b'];

/** Por subdominio: también limpia lo que dejara una ejecución cortada. */
async function cleanup(): Promise<void> {
  const tenantIds = (
    await raw.tenant.findMany({
      where: { subdomain: { in: SUBDOMAINS } },
      select: { id: true },
    })
  ).map((t) => t.id);
  const where = { tenantId: { in: tenantIds } };
  await raw.prescription.deleteMany({ where });
  await raw.medicalHistoryVersion.deleteMany({ where });
  await raw.patient.deleteMany({ where });
  await raw.location.deleteMany({ where });
  await raw.clinicMembership.deleteMany({ where });
  await raw.user.deleteMany({
    where: { email: { in: SUBDOMAINS.map((s) => `dr@${s}.test`) } },
  });
  await raw.tenant.deleteMany({ where: { id: { in: tenantIds } } });
}

const item = (activeIngredient: string) => ({
  activeIngredient,
  concentration: '400 mg',
  pharmaceuticalForm: 'Comprimido',
  route: 'Oral',
  dose: '1 comprimido',
  frequency: 'Cada 8 horas',
  durationDays: 3,
  totalQuantity: 9,
  quantityUnit: 'comprimidos',
});

describe('receta segura: emisión con anamnesis real (DX-300, int)', () => {
  let a: Seeded;
  let b: Seeded;
  const issue = new IssuePrescriptionUseCase(
    repo,
    NOW,
    new PrismaDocumentTypeNamesRepository(prisma, tenantContext),
  );
  const check = new CheckPrescriptionSafetyUseCase(repo, NOW);
  const get = new GetPrescriptionUseCase(repo);

  const inClinic = <T>(s: Seeded, fn: () => Promise<T>) =>
    tenantContext.run(s.tenantId, s.locationId, fn);

  beforeAll(async () => {
    await prisma.onModuleInit();
    await cleanup();
    a = await seedClinic('rxs-int-a');
    b = await seedClinic('rxs-int-b');
    // v1 antigua (sin nada); v2 VIGENTE: casilla de penicilina con la lista
    // vacía y warfarina en la medicación habitual.
    await raw.medicalHistoryVersion.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        version: 1,
        allergies: [],
        medications: [],
        safetyFlags: {},
      },
    });
    await raw.medicalHistoryVersion.create({
      data: {
        tenantId: a.tenantId,
        patientId: a.patientId,
        version: 2,
        allergies: [],
        medications: [{ nombre: 'Warfarina', esAlerta: true }],
        safetyFlags: { alergiaPenicilina: true, anticoagulantes: true },
        hasCriticalAlert: true,
      },
    });
  });

  afterAll(async () => {
    await cleanup();
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('lee la versión vigente: casilla de penicilina y warfarina dan 409 sin confirmación', async () => {
    for (const ingredient of ['Amoxicilina', 'Ibuprofeno']) {
      await expect(
        inClinic(a, () =>
          issue.execute(a.patientId, { items: [item(ingredient)] }, a.userId),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    }
    expect(
      await raw.prescription.count({ where: { tenantId: a.tenantId } }),
    ).toBe(0);
  });

  it('con confirmación y motivo guarda avisos y motivo en la fila, dentro del hash', async () => {
    const rx = await inClinic(a, () =>
      issue.execute(
        a.patientId,
        {
          items: [item('Ibuprofeno')],
          safetyOverride: true,
          safetyOverrideReason: 'INR en rango; 48 h',
        },
        a.userId,
      ),
    );
    const row = await raw.prescription.findUniqueOrThrow({
      where: { id: rx.id },
    });
    expect(row.safetyRulesVersion).toBe('RX_SAFETY_V1');
    expect(row.safetyOverrideReason).toBe('INR en rango; 48 h');
    expect(row.safetyAlerts).toEqual([
      expect.objectContaining({
        code: 'INTERACTION_ANTICOAGULANT_NSAID',
        severity: 'BLOCKING',
      }),
    ]);
    const doc = await inClinic(a, () => get.execute(rx.id));
    expect(doc.integrityOk).toBe(true);

    // El motivo y los avisos son contenido inmutable (trigger de DX-013).
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.prescription.update({
          where: { id: rx.id },
          data: { safetyOverrideReason: 'Otro motivo' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('RLS: otra clínica no lee la anamnesis ni previsualiza avisos del paciente de A', async () => {
    await expect(
      inClinic(b, () =>
        check.execute(
          a.patientId,
          [{ activeIngredient: 'Ibuprofeno' }],
          b.userId,
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      inClinic(b, () => repo.loadPatient(a.patientId)),
    ).resolves.toBe(null);
  });

  it('legacy: una receta emitida antes de la receta segura y de la receta única (columnas NULL, país, hash v1) sigue validando', async () => {
    const issuedAt = new Date('2026-10-16T15:00:00.000Z');
    const content = {
      country: 'CO' as const,
      issuedAt,
      dispensationDate: '2026-10-16',
      validUntil: '2026-11-14',
      patientId: a.patientId,
      patientName: 'Ana rxs-int-a',
      patientDocument: null,
      patientBirthYear: null,
      clinicalRecordNumber: '123',
      professionalId: a.userId,
      professionalName: 'Dra. Prueba',
      professionalLicense: 'RM-1',
      professionalEmail: null,
      clinicName: 'Clínica',
      locationName: 'Sede',
      locationAddress: null,
      notes: null,
      allergyOverride: false,
      allergyMatches: [],
      safetyRulesVersion: null,
      safetyAlerts: null,
      safetyOverrideReason: null,
      items: [
        {
          ...item('Paracetamol'),
          position: 1,
          brandName: null,
          quantityInWords: 'nueve',
          packages: null,
          instructions: null,
        },
      ],
    };
    const { items, allergyMatches, ...rest } = content;
    const legacy = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.prescription.create({
        data: {
          ...rest,
          tenantId: a.tenantId,
          locationId: a.locationId,
          dispensationDate: new Date('2026-10-16T00:00:00.000Z'),
          validUntil: new Date('2026-11-14T00:00:00.000Z'),
          allergyMatches: allergyMatches,
          safetyAlerts: Prisma.DbNull,
          contentHash: computePrescriptionHash(content),
          items: { create: items },
        },
      }),
    );
    const doc = await inClinic(a, () => get.execute(legacy.id));
    expect(doc.safetyAlerts).toBeNull();
    expect(doc.safetyRulesVersion).toBeNull();
    expect(doc.integrityOk).toBe(true);
  });

  it('CHECK: sin avisos no hay motivo; motivo en blanco no; avisos sin versión no', async () => {
    const base = await raw.prescription.findFirstOrThrow({
      where: { tenantId: a.tenantId, safetyAlerts: { not: Prisma.DbNull } },
    });
    const {
      id: _id,
      createdAt: _c,
      allergyMatches: _m,
      safetyAlerts: _s,
      ...copy
    } = base;
    const attempt = (extra: Prisma.PrescriptionUncheckedCreateInput) =>
      raw.prescription.create({ data: extra });
    const data = (
      over: Partial<Prisma.PrescriptionUncheckedCreateInput>,
    ): Prisma.PrescriptionUncheckedCreateInput => ({
      ...copy,
      allergyMatches: [],
      ...over,
    });
    await expect(
      attempt(
        data({
          safetyAlerts: Prisma.DbNull,
          safetyRulesVersion: null,
          safetyOverrideReason: 'x',
        }),
      ),
    ).rejects.toThrow(/prescriptions_safety_check/);
    await expect(
      attempt(data({ safetyAlerts: [], safetyOverrideReason: '   ' })),
    ).rejects.toThrow(/prescriptions_safety_check/);
    await expect(
      attempt(data({ safetyAlerts: [], safetyRulesVersion: null })),
    ).rejects.toThrow(/prescriptions_safety_check/);
  });
});
