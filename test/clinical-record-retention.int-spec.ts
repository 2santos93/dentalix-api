import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaPatientRepository } from '../src/modules/patients/infrastructure/repositories/prisma-patient.repository';
import { assertNotUnderRetention } from '../src/modules/patients/application/retention-guard';

// DX-039, capa DB de la retención legal de la HC: backfill de la migración,
// triggers que mantienen `last_attention_at` (nunca retrocede), RLS FORZADA y
// append-only de `patient_retention_actions`, y la supresión parcial por la
// misma ruta que la app (runWithTenant, rol dentalix_app).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);

const MIGRATION = readFileSync(
  join(
    __dirname,
    '../prisma/migrations/20261017170000_dx039_clinical_record_retention/migration.sql',
  ),
  'utf8',
);
/** La sentencia de backfill tal cual está en la migración. */
const BACKFILL = /UPDATE "patients" p[\s\S]*?;/.exec(MIGRATION)?.[0] ?? '';

let tenantA: string;
let tenantB: string;
let locationA: string;
let userId: string;

async function newPatient(tenantId: string, name: string): Promise<string> {
  return (
    await raw.patient.create({
      data: {
        tenantId,
        firstName: name,
        lastName: 'DX039',
        phone: '3001112233',
        email: `${name.toLowerCase()}@example.com`,
        address: 'Calle 1 # 2-3',
        notes: 'Prefiere citas en la tarde',
        emergencyContactName: 'Luis',
        emergencyContactRelationship: 'Hermano',
        emergencyContactPhone: '3004445566',
        occupation: 'Docente',
        insurerEps: 'Sura',
      },
    })
  ).id;
}

function lastAttention(id: string): Promise<Date | null> {
  return raw.patient
    .findUniqueOrThrow({ where: { id }, select: { lastAttentionAt: true } })
    .then((p) => p.lastAttentionAt);
}

function entry(tenantId: string, patientId: string, iso: string) {
  return prisma.runWithTenant(tenantId, (tx) =>
    tx.clinicalEntry.create({
      data: {
        tenantId,
        patientId,
        entryDate: new Date(iso),
        notes: 'Control',
        performedById: userId,
      },
    }),
  );
}

function appointment(
  patientId: string,
  iso: string,
  status: 'SCHEDULED' | 'COMPLETED' = 'SCHEDULED',
) {
  return prisma.runWithTenant(tenantA, (tx) =>
    tx.appointment.create({
      data: {
        tenantId: tenantA,
        locationId: locationA,
        patientId,
        providerId: userId,
        start: new Date(iso),
        end: new Date(new Date(iso).getTime() + 30 * 60_000),
        status,
      },
    }),
  );
}

describe('retención legal de la HC (DX-039, int)', () => {
  beforeAll(async () => {
    await prisma.onModuleInit();
    userId = (
      await raw.user.create({
        data: {
          email: 'dx039-int@example.com',
          passwordHash: 'x',
          fullName: 'Dra. Retención',
        },
      })
    ).id;
    tenantA = (
      await raw.tenant.create({
        data: { name: 'dx039-a', subdomain: 'dx039-int-a' },
      })
    ).id;
    tenantB = (
      await raw.tenant.create({
        data: { name: 'dx039-b', subdomain: 'dx039-int-b' },
      })
    ).id;
    locationA = (
      await raw.location.create({ data: { tenantId: tenantA, name: 'Sede' } })
    ).id;
  });

  afterAll(async () => {
    const where = { tenantId: { in: [tenantA, tenantB] } };
    await raw.patientRetentionAction.deleteMany({ where });
    await raw.dataProcessingConsent.deleteMany({ where });
    await raw.privacyPolicyVersion.deleteMany({ where });
    await raw.appointment.deleteMany({ where });
    await raw.clinicalEntry.deleteMany({ where });
    await raw.patient.deleteMany({ where });
    await raw.location.deleteMany({ where });
    await raw.tenant.deleteMany({ where: { id: { in: [tenantA, tenantB] } } });
    await raw.user.delete({ where: { id: userId } });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  it('una evolución nueva adelanta last_attention_at y una más antigua no la atrasa', async () => {
    const p = await newPatient(tenantA, 'Evol');
    expect(await lastAttention(p)).toBeNull();
    await entry(tenantA, p, '2026-03-10T15:00:00Z');
    expect(await lastAttention(p)).toEqual(new Date('2026-03-10T15:00:00Z'));
    await entry(tenantA, p, '2025-01-01T15:00:00Z');
    expect(await lastAttention(p)).toEqual(new Date('2026-03-10T15:00:00Z'));
  });

  it('una cita cuenta al quedar COMPLETED (no agendada ni cancelada), y nunca retrocede', async () => {
    const p = await newPatient(tenantA, 'Cita');
    const appt = await appointment(p, '2026-05-02T14:00:00Z');
    expect(await lastAttention(p)).toBeNull();
    await prisma.runWithTenant(tenantA, (tx) =>
      tx.appointment.update({
        where: { id: appt.id },
        data: { status: 'COMPLETED' },
      }),
    );
    expect(await lastAttention(p)).toEqual(new Date('2026-05-02T14:00:00Z'));
    // Una cita atendida anterior no mueve la fecha hacia atrás.
    await appointment(p, '2024-05-02T14:00:00Z', 'COMPLETED');
    expect(await lastAttention(p)).toEqual(new Date('2026-05-02T14:00:00Z'));
    // Volver a SCHEDULED tampoco la retrocede (la atención ya ocurrió).
    await prisma.runWithTenant(tenantA, (tx) =>
      tx.appointment.update({
        where: { id: appt.id },
        data: { status: 'SCHEDULED' },
      }),
    );
    expect(await lastAttention(p)).toEqual(new Date('2026-05-02T14:00:00Z'));
  });

  it('una fecha futura (evolución o cita) no lleva last_attention_at más allá de ahora', async () => {
    // entryDate y start los fija el cliente: sin tope, una evolución fechada
    // en 2099 (inmutable) alargaría la retención para siempre sin pasar por
    // el ADMIN.
    const before = new Date();
    const p = await newPatient(tenantA, 'Futura');
    await entry(tenantA, p, '2099-01-01T15:00:00Z');
    const afterEntry = await lastAttention(p);
    expect(afterEntry).not.toBeNull();
    expect(afterEntry!.getTime()).toBeGreaterThanOrEqual(
      before.getTime() - 1000,
    );
    expect(afterEntry!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);

    const q = await newPatient(tenantA, 'CitaFutura');
    await appointment(q, '2099-06-01T15:00:00Z', 'COMPLETED');
    const afterAppt = await lastAttention(q);
    expect(afterAppt).not.toBeNull();
    expect(afterAppt!.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('backfill de la migración: max de evoluciones y citas atendidas vivas', async () => {
    expect(BACKFILL).toContain('UPDATE "patients" p');
    const both = await newPatient(tenantA, 'Backfill');
    const none = await newPatient(tenantA, 'SinAtencion');
    const onlyScheduled = await newPatient(tenantA, 'SoloAgenda');
    await entry(tenantA, both, '2023-06-01T10:00:00Z');
    await appointment(both, '2024-08-01T10:00:00Z', 'COMPLETED');
    // Cita atendida pero borrada: no cuenta. Agendada a futuro: tampoco.
    const deleted = await appointment(
      both,
      '2025-09-01T10:00:00Z',
      'COMPLETED',
    );
    await appointment(onlyScheduled, '2027-01-01T10:00:00Z');
    // Estado previo a la migración: columna vacía.
    await raw.$executeRawUnsafe(
      `UPDATE "appointments" SET "deletedAt" = now() WHERE id = '${deleted.id}'`,
    );
    await raw.$executeRawUnsafe(
      `UPDATE "patients" SET "last_attention_at" = NULL WHERE "tenantId" = '${tenantA}'`,
    );

    await raw.$executeRawUnsafe(BACKFILL);

    expect(await lastAttention(both)).toEqual(new Date('2024-08-01T10:00:00Z'));
    expect(await lastAttention(none)).toBeNull();
    expect(await lastAttention(onlyScheduled)).toBeNull();
  });

  it('el trigger respeta la RLS: solo toca pacientes del tenant de la fila', async () => {
    const pB = await newPatient(tenantB, 'OtroTenant');
    // Desde el tenant A no se puede insertar una evolución de un paciente de B
    // (FK compuesta + RLS), así que la fecha de B no se mueve.
    await expect(entry(tenantA, pB, '2026-01-01T00:00:00Z')).rejects.toThrow();
    expect(await lastAttention(pB)).toBeNull();
  });

  it('archivar bajo retención falla dentro de la transacción y no marca deletedAt', async () => {
    const repo = new PrismaPatientRepository(prisma, tenantContext);
    const p = await newPatient(tenantA, 'Archivo');
    await entry(tenantA, p, '2026-02-01T10:00:00Z');
    const now = new Date('2026-10-16T12:00:00Z');
    await expect(
      tenantContext.run(tenantA, () =>
        repo.archive(p, (s) => assertNotUnderRetention(s, now)),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'CLINICAL_RECORD_RETENTION',
        retentionUntil: '2041-02-01',
      },
    });
    const row = await raw.patient.findUniqueOrThrow({ where: { id: p } });
    expect(row.deletedAt).toBeNull();

    const fresh = await newPatient(tenantA, 'Duplicado');
    await tenantContext.run(tenantA, () =>
      repo.archive(fresh, (s) => assertNotUnderRetention(s, now)),
    );
    expect(
      (await raw.patient.findUniqueOrThrow({ where: { id: fresh } })).deletedAt,
    ).not.toBeNull();
  });

  it('supresión parcial: vacía lo no clínico, retira marketing, conserva la HC y deja rastro', async () => {
    const repo = new PrismaPatientRepository(prisma, tenantContext);
    const p = await newPatient(tenantA, 'Supresion');
    const e = await entry(tenantA, p, '2026-02-01T10:00:00Z');
    const policy = await raw.privacyPolicyVersion.create({
      data: {
        tenantId: tenantA,
        version: 1,
        policyText: 'Política',
        generalText: 'General',
        sensitiveHealthText: 'Salud',
        marketingText: 'Marketing',
        contentHash: 'x',
        publishedById: userId,
      },
    });
    await raw.dataProcessingConsent.create({
      data: {
        tenantId: tenantA,
        patientId: p,
        policyVersionId: policy.id,
        scope: 'MARKETING',
        granted: true,
        channel: 'IN_PERSON',
        recordedById: userId,
      },
    });

    const result = await tenantContext.run(tenantA, () =>
      repo.partiallySuppress(p, {
        reason: 'Reclamo del titular por Ley 1581',
        actorId: userId,
        assertAllowed: () => undefined,
      }),
    );

    expect(result).toMatchObject({
      phone: null,
      email: null,
      address: null,
      notes: null,
      emergencyContactName: null,
      emergencyContactRelationship: null,
      emergencyContactPhone: null,
      // Identificación que exige la HC: se conserva.
      firstName: 'Supresion',
      occupation: 'Docente',
      insurerEps: 'Sura',
      underRetention: true,
    });
    expect(result.partiallySuppressedAt).toBeInstanceOf(Date);
    expect(
      await raw.clinicalEntry.findUnique({ where: { id: e.id } }),
    ).not.toBeNull();
    const marketing = await raw.dataProcessingConsent.findMany({
      where: { patientId: p, scope: 'MARKETING' },
      orderBy: { recordedAt: 'asc' },
    });
    expect(marketing.map((m) => m.granted)).toEqual([true, false]);
    const actions = await raw.patientRetentionAction.findMany({
      where: { patientId: p },
    });
    expect(actions).toEqual([
      expect.objectContaining({
        kind: 'PARTIAL_SUPPRESSION',
        reason: 'Reclamo del titular por Ley 1581',
        actorId: userId,
      }),
    ]);
  });

  it('patient_retention_actions: RLS forzada entre tenants y append-only para la app', async () => {
    const repo = new PrismaPatientRepository(prisma, tenantContext);
    const p = await newPatient(tenantA, 'Extension');
    const updated = await tenantContext.run(tenantA, () =>
      repo.setRetentionExtension(p, {
        value: 'DOUBLE',
        reason: 'Víctima del conflicto armado',
        actorId: userId,
      }),
    );
    expect(updated.retentionExtended).toBe('DOUBLE');

    const fromB = await prisma.runWithTenant(tenantB, (tx) =>
      tx.patientRetentionAction.findMany({ where: { patientId: p } }),
    );
    expect(fromB).toEqual([]);
    const fromA = await prisma.runWithTenant(tenantA, (tx) =>
      tx.patientRetentionAction.findMany({ where: { patientId: p } }),
    );
    expect(fromA).toEqual([
      expect.objectContaining({
        previousExtension: 'NONE',
        newExtension: 'DOUBLE',
      }),
    ]);
    await expect(
      prisma.runWithTenant(tenantA, (tx) =>
        tx.patientRetentionAction.updateMany({
          where: { patientId: p },
          data: { reason: 'Cambiado a escondidas' },
        }),
      ),
    ).rejects.toThrow(/inalterable/);
    await expect(
      prisma.runWithTenant(tenantA, (tx) =>
        // Por SQL: el cliente de la app ya prohíbe deleteMany (no-hard-delete);
        // aquí se prueba la capa de BD.
        tx.$executeRawUnsafe(
          `DELETE FROM "patient_retention_actions" WHERE "patientId" = '${p}'`,
        ),
      ),
    ).rejects.toThrow(/inalterable/);
  });
});
