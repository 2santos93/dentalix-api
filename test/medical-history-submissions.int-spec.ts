import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaMedicalHistorySubmissionRepository } from '../src/modules/medical-history-submissions/infrastructure/prisma-medical-history-submission.repository';
import { proposeVersionFromAnswers } from '../src/modules/medical-history-submissions/domain/answers-to-version';
import { allNoAnswers } from '../src/modules/medical-history-submissions/domain/__fixtures__/anamnesis-answers';
import {
  generateAnamnesisToken,
  hashAnamnesisToken,
} from '../src/modules/medical-history-submissions/domain/anamnesis-token';
import { resetDatabase } from './support/e2e-fixtures';

// DX-099 contra Postgres: la tabla medical_history_submissions con RLS FORCE
// (un token de la clínica A no existe con el tenant B), FK compuestas por
// tenant (paciente, sede y versión resultante de la MISMA clínica y del MISMO
// paciente), su ciclo de vida en la BD (CHECK de estado, guard de UPDATE, sin
// DELETE) y que aceptar es una transacción: envío ACCEPTED + versión creada,
// o nada.
//
// `owner` (DIRECT_URL) siembra e inspecciona; la app va por PrismaService
// (rol dentalix_app, sujeto a RLS).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaMedicalHistorySubmissionRepository(
  prisma,
  tenantContext,
);

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  otherPatientId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: { tenantId: tenant.id, name: `Sede ${subdomain}` },
  });
  const user = await owner.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: `Recepción ${subdomain}`,
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'RECEPTION' },
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
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: (await patient('Ana')).id,
    otherPatientId: (await patient('Otro')).id,
    userId: user.id,
  };
}

function asClinic<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(tenantId, fn);
}

/** Emite un enlace como la app (bajo RLS) y devuelve su id y token. */
async function issue(clinic: Seeded): Promise<{ id: string; token: string }> {
  const token = generateAnamnesisToken();
  const issued = await asClinic(clinic.tenantId, () =>
    repo.issue({
      patientId: clinic.patientId,
      appointmentId: null,
      locationId: clinic.locationId,
      tokenHash: hashAnamnesisToken(token),
      expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      questionnaireVersion: '2026-10-v1',
      createdById: clinic.userId,
    }),
  );
  return { id: issued.submission.id, token };
}

async function submitted(clinic: Seeded): Promise<string> {
  const { id } = await issue(clinic);
  const answers = allNoAnswers();
  answers.allergies = {
    answer: 'SI',
    items: [{ alergeno: 'Látex', tipo: 'MATERIAL', severidad: 'LEVE' }],
  };
  const outcome = await asClinic(clinic.tenantId, () =>
    repo.submit({
      id,
      patientId: clinic.patientId,
      answers,
      now: new Date(),
      consentPolicyVersionId: null,
      evidence: { ipAddress: '127.0.0.1', userAgent: 'int' },
      requestId: null,
    }),
  );
  expect(outcome).toBe('SUBMITTED');
  return id;
}

const versionsOf = (clinic: Seeded) =>
  owner.medicalHistoryVersion.count({
    where: { tenantId: clinic.tenantId, patientId: clinic.patientId },
  });

describe('medical_history_submissions en Postgres (DX-099)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx099-int-a');
    b = await seedClinic('dx099-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  describe('RLS y FK compuestas', () => {
    it('un token de la clínica A no existe con el tenant B (ni sus envíos)', async () => {
      const { token } = await issue(a);
      const hash = hashAnamnesisToken(token);
      expect(
        await asClinic(a.tenantId, () => repo.findByTokenHash(hash)),
      ).not.toBeNull();
      expect(
        await asClinic(b.tenantId, () => repo.findByTokenHash(hash)),
      ).toBeNull();
      expect(
        await asClinic(b.tenantId, () => repo.listForPatient(a.patientId, 10)),
      ).toEqual([]);
      expect(
        await asClinic(b.tenantId, () => repo.listInbox('PENDING_PATIENT', 10)),
      ).toEqual([]);
    });

    it('la app no puede escribir una fila de otra clínica (WITH CHECK)', async () => {
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.medicalHistorySubmission.create({
            data: {
              tenantId: b.tenantId,
              patientId: b.patientId,
              locationId: b.locationId,
              tokenHash: hashAnamnesisToken(generateAnamnesisToken()),
              expiresAt: new Date(Date.now() + 1000),
              questionnaireVersion: 'v',
              createdById: b.userId,
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('paciente, sede y versión resultante tienen que ser de la MISMA clínica (y del mismo paciente)', async () => {
      const base = {
        tenantId: a.tenantId,
        patientId: a.patientId,
        locationId: a.locationId,
        expiresAt: new Date(Date.now() + 1000),
        questionnaireVersion: 'v',
        createdById: a.userId,
      };
      const token = () => hashAnamnesisToken(generateAnamnesisToken());
      await expect(
        owner.medicalHistorySubmission.create({
          data: { ...base, patientId: b.patientId, tokenHash: token() },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      await expect(
        owner.medicalHistorySubmission.create({
          data: { ...base, locationId: b.locationId, tokenHash: token() },
        }),
      ).rejects.toMatchObject({ code: 'P2003' });
      // Versión de OTRO paciente de la misma clínica como resultante.
      const foreign = await owner.medicalHistoryVersion.create({
        data: {
          tenantId: a.tenantId,
          patientId: a.otherPatientId,
          version: 1,
          safetyFlags: {},
        },
      });
      await expect(
        owner.$executeRaw`INSERT INTO "medical_history_submissions"
          ("id", "tenantId", "patientId", "locationId", "tokenHash", "expiresAt",
           "status", "questionnaireVersion", "answers", "submittedAt",
           "reviewedById", "reviewedAt", "resultingVersionId", "createdById", "updatedAt")
          VALUES (${randomUUID()}::uuid, ${a.tenantId}::uuid, ${a.patientId}::uuid,
            ${a.locationId}::uuid, ${token()}, now() + interval '1 hour',
            'ACCEPTED', 'v', '{}'::jsonb, now(), ${a.userId}::uuid, now(),
            ${foreign.id}::uuid, ${a.userId}::uuid, now())`,
      ).rejects.toThrow(/medical_history_submissions_version_fkey/);
    });

    it('el token se guarda como hash único (SHA-256 hex)', async () => {
      const { token } = await issue(a);
      await expect(
        owner.medicalHistorySubmission.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            locationId: a.locationId,
            tokenHash: token,
            expiresAt: new Date(Date.now() + 1000),
            questionnaireVersion: 'v',
            createdById: a.userId,
          },
        }),
      ).rejects.toThrow(/medical_history_submissions_token_check/);
    });
  });

  describe('ciclo de vida en la BD', () => {
    it('ACCEPTED sin versión resultante no pasa el CHECK de estado', async () => {
      const id = await submitted(a);
      await expect(
        owner.medicalHistorySubmission.update({
          where: { id },
          data: {
            status: 'ACCEPTED',
            reviewedById: a.userId,
            reviewedAt: new Date(),
          },
        }),
      ).rejects.toThrow(/medical_history_submissions_state_check/);
    });

    it('las respuestas no se reescriben, un envío revisado no cambia y no se borra', async () => {
      const id = await submitted(a);
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.medicalHistorySubmission.update({
            where: { id },
            data: { answers: { hackeado: true } },
          }),
        ),
      ).rejects.toThrow(/no se reescriben/);
      const rejected = await asClinic(a.tenantId, () =>
        repo.reject({
          id,
          reviewerId: a.userId,
          reason: 'Datos de otra persona',
        }),
      );
      expect(rejected.kind).toBe('OK');
      await expect(
        prisma.runWithTenant(a.tenantId, (tx) =>
          tx.medicalHistorySubmission.update({
            where: { id },
            data: { rejectReason: 'Otro motivo' },
          }),
        ),
      ).rejects.toThrow(/no cambia/);
      await expect(
        prisma.runWithTenant(
          a.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "medical_history_submissions" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/inalterable/);
    });
  });

  describe('aceptar es transaccional', () => {
    const build =
      () => (current: Parameters<typeof proposeVersionFromAnswers>[1]) =>
        proposeVersionFromAnswers(allNoAnswers(), current);

    it('si el cambio de estado falla, la versión creada se deshace (ni envío ACCEPTED ni versión)', async () => {
      const id = await submitted(a);
      const before = await versionsOf(a);
      await owner.$executeRawUnsafe(`
        CREATE FUNCTION dx099_int_fail_accept() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW."status" = 'ACCEPTED' AND NEW."id" = '${id}'::uuid THEN
            RAISE EXCEPTION 'fallo simulado al aceptar';
          END IF;
          RETURN NEW;
        END $$`);
      await owner.$executeRawUnsafe(`
        CREATE TRIGGER dx099_fail_accept BEFORE UPDATE ON medical_history_submissions
        FOR EACH ROW EXECUTE FUNCTION dx099_int_fail_accept()`);
      try {
        await expect(
          asClinic(a.tenantId, () =>
            repo.accept({ id, reviewerId: a.userId, build: build() }),
          ),
        ).rejects.toThrow(/fallo simulado/);
      } finally {
        await owner.$executeRawUnsafe(
          'DROP TRIGGER dx099_fail_accept ON medical_history_submissions',
        );
        await owner.$executeRawUnsafe('DROP FUNCTION dx099_int_fail_accept()');
      }
      expect(await versionsOf(a)).toBe(before);
      const row = await owner.medicalHistorySubmission.findUniqueOrThrow({
        where: { id },
      });
      expect(row).toMatchObject({
        status: 'SUBMITTED',
        resultingVersionId: null,
      });
    });

    it('dos aceptaciones a la vez: una crea la versión y la otra da conflicto', async () => {
      const id = await submitted(a);
      const before = await versionsOf(a);
      const outcomes = await Promise.all([
        asClinic(a.tenantId, () =>
          repo.accept({ id, reviewerId: a.userId, build: build() }),
        ),
        asClinic(a.tenantId, () =>
          repo.accept({ id, reviewerId: a.userId, build: build() }),
        ),
      ]);
      expect(outcomes.map((o) => o.kind).sort()).toEqual(['CONFLICT', 'OK']);
      expect(await versionsOf(a)).toBe(before + 1);
      const row = await owner.medicalHistorySubmission.findUniqueOrThrow({
        where: { id },
      });
      const version = await owner.medicalHistoryVersion.findUniqueOrThrow({
        where: { id: row.resultingVersionId! },
      });
      expect(version).toMatchObject({
        source: 'PATIENT_FORM',
        createdById: a.userId,
        patientId: a.patientId,
      });
    });

    it('B no acepta un envío de A (no existe bajo su RLS)', async () => {
      const id = await submitted(a);
      const outcome = await asClinic(b.tenantId, () =>
        repo.accept({ id, reviewerId: b.userId, build: build() }),
      );
      expect(outcome.kind).toBe('NOT_FOUND');
    });
  });
});
