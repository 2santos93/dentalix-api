import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaMedicalAlertsRepository } from '../src/modules/medical-history/infrastructure/repositories/prisma-medical-alerts.repository';
import { lockPatientAnamnesis } from '../src/modules/medical-history/infrastructure/repositories/anamnesis-lock';
import { createE2eApp } from './support/create-e2e-app';
import {
  registerClinic,
  resetDatabase,
  type Clinic,
} from './support/e2e-fixtures';

// DX-247 contra Postgres: banderas por lote bajo RLS (aislamiento entre
// clínicas), la confirmación «Sin cambios hoy» (FK compuestas a la versión y
// al paciente, RLS FORCE), la vigencia de la clínica (CHECK 1..60) y que la
// confirmación por la API deja su evento de auditoría sin contenido clínico.
//
// `owner` (DIRECT_URL) solo siembra e inspecciona; las lecturas y escrituras
// de la app van por PrismaService (rol dentalix_app, sujeto a RLS).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaMedicalAlertsRepository(prisma, tenantContext);

interface Seeded {
  tenantId: string;
  withHistory: string;
  withoutHistory: string;
  /** Versión vigente (2) de `withHistory`. */
  currentVersion: string;
}

const FK_VIOLATION = { code: 'P2003' };

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const patient = (firstName: string) =>
    owner.patient.create({
      data: {
        tenantId: tenant.id,
        firstName,
        lastName: 'Int',
        docNumber: randomUUID().slice(0, 12),
      },
    });
  const withHistory = await patient('Con');
  const withoutHistory = await patient('Sin');
  // v1 (vieja, sin alertas) y v2 (vigente, profilaxis + alergia marcada);
  // una v3 retirada en blando no cuenta.
  await owner.medicalHistoryVersion.create({
    data: {
      tenantId: tenant.id,
      patientId: withHistory.id,
      version: 1,
      safetyFlags: {},
      hasCriticalAlert: false,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
    },
  });
  const current = await owner.medicalHistoryVersion.create({
    data: {
      tenantId: tenant.id,
      patientId: withHistory.id,
      version: 2,
      allergies: [
        {
          alergeno: 'Ibuprofeno',
          tipo: 'MEDICAMENTO',
          severidad: 'MODERADA',
          esAlerta: true,
        },
        {
          alergeno: 'Polen',
          tipo: 'AMBIENTAL',
          severidad: 'LEVE',
          esAlerta: false,
        },
      ],
      conditions: [
        {
          codigo: 'VALVULOPATIA',
          etiqueta: 'Valvulopatía',
          estado: 'SI',
          esAlerta: true,
        },
      ],
      safetyFlags: { profilaxisAntibiotica: true },
      hasCriticalAlert: true,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    },
  });
  await owner.medicalHistoryVersion.create({
    data: {
      tenantId: tenant.id,
      patientId: withHistory.id,
      version: 3,
      safetyFlags: {},
      hasCriticalAlert: false,
      deletedAt: new Date(),
    },
  });
  return {
    tenantId: tenant.id,
    withHistory: withHistory.id,
    withoutHistory: withoutHistory.id,
    currentVersion: current.id,
  };
}

/** Corre `fn` como la app, con la clínica (y opcionalmente la sede) en contexto. */
function asClinic<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(tenantId, fn);
}

describe('DX-247 · banderas médicas y «Sin cambios hoy» en la BD (int)', () => {
  // Sin clínica en contexto la app no ve nada: lo cubre `rls-catalog.int-spec`
  // para toda tabla con RLS FORCE, esta incluida.
  let a: Seeded;
  let b: Seeded;
  const reviewer = randomUUID();

  beforeAll(async () => {
    await prisma.onModuleInit();
    await resetDatabase(owner);
    a = await seedClinic('dx247-int-a');
    b = await seedClinic('dx247-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.onModuleDestroy();
  });

  it('la tabla tiene RLS forzada y la vigencia nace en 12', async () => {
    const [table] = await owner.$queryRaw<
      { rls: boolean; force: boolean }[]
    >`SELECT relrowsecurity AS rls, relforcerowsecurity AS force
        FROM pg_class WHERE relname = 'medical_history_reviews'`;
    expect(table).toEqual({ rls: true, force: true });
    const tenant = await owner.tenant.findUniqueOrThrow({
      where: { id: a.tenantId },
    });
    expect(tenant.anamnesisValidityMonths).toBe(12);
  });

  it('banderas por lote: la versión vigente viva, sin el texto de las alergias, y solo de MI clínica', async () => {
    const states = await asClinic(a.tenantId, () =>
      repo.reviewStates([a.withHistory, a.withoutHistory, b.withHistory]),
    );
    expect([...states.keys()]).toEqual([a.withHistory]);
    const state = states.get(a.withHistory)!;
    expect(state.snapshot).toEqual({
      versionId: a.currentVersion,
      safetyFlags: { profilaxisAntibiotica: true },
      hasCriticalAlert: true,
      alertAllergens: ['Ibuprofeno'],
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    expect(state.lastConfirmedAt).toBeNull();
  });

  it('«Sin cambios hoy» guarda autor y hora, y la última cuenta en el lote', async () => {
    const before = Date.now();
    const confirmation = await asClinic(a.tenantId, () =>
      repo.createConfirmation({
        patientId: a.withHistory,
        reviewedById: reviewer,
      }),
    );
    if (!confirmation) throw new Error('sin confirmación');
    expect(confirmation).toMatchObject({
      patientId: a.withHistory,
      medicalHistoryVersionId: a.currentVersion,
      reviewedById: reviewer,
      locationId: null,
    });
    expect(confirmation.reviewedAt.getTime()).toBeGreaterThanOrEqual(
      before - 5_000,
    );
    const states = await asClinic(a.tenantId, () =>
      repo.reviewStates([a.withHistory]),
    );
    expect(states.get(a.withHistory)?.lastConfirmedAt).toEqual(
      confirmation.reviewedAt,
    );
    const last = await asClinic(a.tenantId, () =>
      repo.lastReview(a.withHistory),
    );
    expect(last).toMatchObject({
      kind: 'NO_CHANGES',
      at: confirmation.reviewedAt,
    });
  });

  it('«Sin cambios hoy» sin anamnesis no escribe nada; de otra clínica, tampoco', async () => {
    await expect(
      asClinic(a.tenantId, () =>
        repo.createConfirmation({
          patientId: a.withoutHistory,
          reviewedById: reviewer,
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      asClinic(a.tenantId, () =>
        repo.createConfirmation({
          patientId: b.withHistory,
          reviewedById: reviewer,
        }),
      ),
    ).resolves.toBeNull();
  });

  it('la confirmación espera a la versión que se está guardando y confirma esa (candado por paciente)', async () => {
    // T1 toma el candado por paciente, inserta la versión 4 y tarda en
    // confirmar; la confirmación que llega mientras tanto tiene que esperar y
    // apuntar a la versión 4, no a la 2 que ya no será la vigente.
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const lockTaken = new Promise<void>((r) => (locked = r));
    let v4 = '';
    const saving = prisma.runWithTenant(a.tenantId, async (tx) => {
      await lockPatientAnamnesis(tx, a.tenantId, a.withHistory);
      v4 = (
        await tx.medicalHistoryVersion.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.withHistory,
            version: 4,
            safetyFlags: {},
            hasCriticalAlert: false,
          },
        })
      ).id;
      locked();
      await held;
    });
    await lockTaken;
    const confirming = asClinic(a.tenantId, () =>
      repo.createConfirmation({
        patientId: a.withHistory,
        reviewedById: reviewer,
      }),
    );
    await new Promise((r) => setTimeout(r, 300));
    release();
    await saving;
    const confirmation = await confirming;
    expect(confirmation?.medicalHistoryVersionId).toBe(v4);
    await owner.$executeRaw`DELETE FROM "medical_history_reviews" WHERE "id" = ${confirmation!.id}::uuid`;
    await owner.$executeRaw`DELETE FROM "medical_history_versions" WHERE "id" = ${v4}::uuid`;
  });

  it('la otra clínica no ve la confirmación de A (RLS)', async () => {
    const seenByB = await prisma.runWithTenant(b.tenantId, (tx) =>
      tx.medicalHistoryReview.count(),
    );
    expect(seenByB).toBe(0);
    const ownerCount = await owner.medicalHistoryReview.count({
      where: { tenantId: a.tenantId },
    });
    expect(ownerCount).toBe(1);
  });

  it('FK compuesta: no se confirma la versión de OTRO paciente ni la de otra clínica', async () => {
    // Versión de A, paciente sin historia de A: la versión no es suya.
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.medicalHistoryReview.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.withoutHistory,
            medicalHistoryVersionId: a.currentVersion,
            reviewedById: reviewer,
          },
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
    // Desde A, paciente y versión de B: ni el paciente ni la versión son de A.
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.medicalHistoryReview.create({
          data: {
            tenantId: a.tenantId,
            patientId: b.withHistory,
            medicalHistoryVersionId: b.currentVersion,
            reviewedById: reviewer,
          },
        }),
      ),
    ).rejects.toMatchObject(FK_VIOLATION);
  });

  it('RLS: desde A no se escribe una fila con el tenant de B', async () => {
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.medicalHistoryReview.create({
          data: {
            tenantId: b.tenantId,
            patientId: b.withHistory,
            medicalHistoryVersionId: b.currentVersion,
            reviewedById: reviewer,
          },
        }),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it('inalterable: la app no cambia ni borra una confirmación, y la hora es del servidor', async () => {
    const created = await prisma.runWithTenant(a.tenantId, (tx) =>
      tx.medicalHistoryReview.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.withHistory,
          medicalHistoryVersionId: a.currentVersion,
          reviewedById: reviewer,
          // Un cliente que intenta antedatarla no lo consigue.
          reviewedAt: new Date('2020-01-01T00:00:00.000Z'),
        },
      }),
    );
    expect(created.reviewedAt.getUTCFullYear()).toBeGreaterThan(2020);
    await expect(
      prisma.runWithTenant(a.tenantId, (tx) =>
        tx.medicalHistoryReview.update({
          where: { id: created.id },
          data: { reviewedById: randomUUID() },
        }),
      ),
    ).rejects.toThrow(/inalterable/);
    await expect(
      prisma.runWithTenant(
        a.tenantId,
        (tx) =>
          // Por SQL: el cliente de la app ni siquiera expone el borrado duro.
          tx.$executeRaw`DELETE FROM "medical_history_reviews" WHERE "id" = ${created.id}::uuid`,
      ),
    ).rejects.toThrow(/inalterable/);
  });

  it('la vigencia de la clínica va de 1 a 60 meses (CHECK) y devuelve antes y después', async () => {
    await expect(
      asClinic(a.tenantId, () => repo.setValidityMonths(6)),
    ).resolves.toEqual({ before: 12, after: 6 });
    await expect(
      asClinic(a.tenantId, () => repo.getValidityMonths()),
    ).resolves.toBe(6);
    await expect(
      asClinic(b.tenantId, () => repo.getValidityMonths()),
    ).resolves.toBe(12);
    for (const months of [0, 61]) {
      await expect(
        owner.tenant.update({
          where: { id: a.tenantId },
          data: { anamnesisValidityMonths: months },
        }),
      ).rejects.toBeInstanceOf(Prisma.PrismaClientUnknownRequestError);
    }
  });
});

describe('DX-247 · auditoría de «Sin cambios hoy» por la API (int)', () => {
  let app: INestApplication<App>;
  let clinic: Clinic;
  let patientId: string;

  const api = () => request(app.getHttpServer());
  const as = (req: request.Test) =>
    req
      .set('X-Tenant-Host', clinic.host)
      .set('Authorization', `Bearer ${clinic.adminToken}`);

  beforeAll(async () => {
    app = await createE2eApp();
    await resetDatabase(owner);
    clinic = await registerClinic(app, 'dx247-int-audit');
    const created = await as(api().post('/api/v1/patients'))
      .send({
        docType: 'CC',
        sex: 'F',
        firstName: 'Paula',
        lastName: 'Premedicada',
        docNumber: '247000111',
      })
      .expect(201);
    patientId = (created.body as { id: string }).id;
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await app.close();
  });

  it('sin anamnesis: 409 y ningún evento', async () => {
    await as(
      api().post(`/api/v1/patients/${patientId}/medical-history/no-changes`),
    ).expect(409);
    const events = await owner.auditEvent.count({
      where: { tenantId: clinic.tenantId, resourceType: 'MEDICAL_HISTORY' },
    });
    expect(events).toBe(0);
  });

  it('con anamnesis: guarda quién y cuándo y deja UN evento sin contenido clínico', async () => {
    await as(api().put(`/api/v1/patients/${patientId}/medical-history`))
      .send({
        allergies: [
          {
            alergeno: 'Clorhexidina',
            tipo: 'MATERIAL',
            severidad: 'ANAFILAXIA',
            esAlerta: true,
          },
        ],
        conditions: [
          {
            codigo: 'ENDOCARDITIS_PREVIA',
            etiqueta: 'Endocarditis previa',
            estado: 'SI',
            esAlerta: true,
          },
        ],
      })
      .expect(200);

    const res = await as(
      api().post(`/api/v1/patients/${patientId}/medical-history/no-changes`),
    ).expect(201);
    const body = res.body as {
      id: string;
      reviewedById: string;
      reviewedByName: string;
      reviewedAt: string;
    };
    expect(body.reviewedById).toBe(clinic.adminUserId);
    expect(body.reviewedByName).toBe('Dr. Owner');

    const row = await owner.medicalHistoryReview.findUniqueOrThrow({
      where: { id: body.id },
    });
    expect(row.reviewedById).toBe(clinic.adminUserId);
    expect(row.reviewedAt.toISOString()).toBe(body.reviewedAt);

    const events = await owner.auditEvent.findMany({
      where: {
        tenantId: clinic.tenantId,
        resourceType: 'MEDICAL_HISTORY',
        action: 'UPDATE',
        resourceId: body.id,
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: clinic.adminUserId,
      actorRole: 'ADMIN',
      patientId,
    });
    expect(events[0].metadata).toMatchObject({
      reason: 'NO_CHANGES_CONFIRMED',
    });
    const serialized = JSON.stringify(events[0]);
    expect(serialized).not.toContain('Clorhexidina');
    expect(serialized).not.toContain('ENDOCARDITIS');
  });

  it('las banderas de la ficha reflejan la confirmación', async () => {
    const res = await as(
      api().get(`/api/v1/patients/${patientId}/medical-alerts`),
    ).expect(200);
    expect(res.body).toMatchObject({
      hasCriticalAlert: true,
      requiresPremedication: true,
      anamnesisStatus: 'CURRENT',
      alerts: ['profilaxisAntibiotica', 'alergiaMarcada'],
      validityMonths: 12,
      lastReview: { kind: 'NO_CHANGES', byName: 'Dr. Owner' },
    });
    expect(JSON.stringify(res.body)).not.toContain('Clorhexidina');
  });
});
