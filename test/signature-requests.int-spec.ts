import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaSignatureRequestRepository } from '../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../src/modules/signature-requests/domain/signature-token';
import type { CreateSignatureRequestRepoInput } from '../src/modules/signature-requests/domain/ports/signature-request-repository.port';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BOGOTA_FIXTURE,
  locationData,
} from './support/location-fixtures';

// DX-243 contra Postgres: signature_requests y patient_consent_countersignatures
// con RLS FORCE (un token de la clínica A no existe con el tenant B), FK
// compuestas por tenant, CHECK de forma y de estado, el guard de UPDATE (una
// solicitud firmada no cambia) y la inmutabilidad de lo firmado: el
// consentimiento a distancia y la firma del profesional no se tocan.
//
// `owner` (DIRECT_URL) siembra e inspecciona; la app va por PrismaService
// (rol dentalix_app, sujeto a RLS).
const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaSignatureRequestRepository(prisma, tenantContext);

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const HASH = 'b'.repeat(64);

interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  otherPatientId: string;
  templateId: string;
  planId: string;
  userId: string;
}

async function seedClinic(subdomain: string): Promise<Seeded> {
  const tenant = await owner.tenant.create({
    data: { name: subdomain, subdomain },
  });
  const location = await owner.location.create({
    data: locationData(REGIONAL_BOGOTA_FIXTURE, {
      tenantId: tenant.id,
      name: `Sede ${subdomain}`,
    }),
  });
  const user = await owner.user.create({
    data: {
      email: `${subdomain}@int.test`,
      passwordHash: 'x',
      fullName: `Dra. ${subdomain}`,
    },
  });
  await owner.clinicMembership.create({
    data: { tenantId: tenant.id, userId: user.id, role: 'DENTIST' },
  });
  const patient = (firstName: string) =>
    owner.patient.create({
      data: {
        tenantId: tenant.id,
        firstName,
        lastName: 'Int',
        email: `${firstName.toLowerCase()}@${subdomain}.test`,
        docNumber: randomUUID().slice(0, 12),
      },
    });
  const p = await patient('Ana');
  const plan = await owner.treatmentPlan.create({
    data: { tenantId: tenant.id, patientId: p.id, currency: 'USD' },
  });
  const template = await owner.consentTemplate.create({
    data: { tenantId: tenant.id, title: 'Exodoncia', body: 'Texto' },
  });
  return {
    tenantId: tenant.id,
    locationId: location.id,
    patientId: p.id,
    otherPatientId: (await patient('Otro')).id,
    templateId: template.id,
    planId: plan.id,
    userId: user.id,
  };
}

function asClinic<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantContext.run(tenantId, fn);
}

function requestInput(
  s: Seeded,
  token: string,
  extra: Partial<CreateSignatureRequestRepoInput> = {},
): CreateSignatureRequestRepoInput {
  const now = new Date();
  return {
    locationId: s.locationId,
    patientId: s.patientId,
    type: 'CONSENT',
    channel: 'EMAIL',
    templateId: s.templateId,
    templateVersion: 1,
    treatmentPlanId: null,
    title: 'Exodoncia',
    body: 'Yo, Ana Int, autorizo…',
    professionalUserId: s.userId,
    professionalName: 'Dra.',
    signerType: 'PATIENT',
    signerName: 'Ana Int',
    signerDocument: null,
    destination: 'ana@example.com',
    destinationMasked: 'an***@example.com',
    tokenHash: hashSignatureToken(token),
    expiresAt: new Date(now.getTime() + 72 * 3600_000),
    createdById: s.userId,
    createdAt: now,
    ...extra,
  };
}

async function issue(s: Seeded): Promise<{ id: string; token: string }> {
  const token = generateSignatureToken();
  const { id } = await asClinic(s.tenantId, () =>
    repo.create(requestInput(s, token)),
  );
  return { id, token };
}

/** Abre, verifica y firma como la app (bajo RLS, con la fila bloqueada). */
async function signed(
  s: Seeded,
): Promise<{ requestId: string; consentId: string }> {
  const { id } = await issue(s);
  const at = new Date();
  await asClinic(s.tenantId, () =>
    repo.withLockedRequest(
      id,
      { ipAddress: '203.0.113.7', userAgent: 'int', requestId: null },
      (r) => ({
        write: {
          patch: { openedAt: at, verifiedAt: at, signedAt: at },
          audit: [{ action: 'SIGN', reason: 'SIGNATURE_PATIENT_SIGNED' }],
          consent: {
            templateId: r.templateId!,
            templateVersion: 1,
            treatmentPlanId: null,
            title: r.title,
            body: r.body,
            signerType: 'PATIENT',
            signerName: r.signerName,
            signerDocument: null,
            professionalName: r.professionalName,
            patientSignature: PNG,
            contentHash: HASH,
            signedAt: at,
            recordedById: r.createdById,
            ipAddress: '203.0.113.7',
            userAgent: 'int',
            remoteChannel: 'EMAIL',
            remoteDestinationMasked: r.destinationMasked,
            remoteSentAt: r.createdAt,
            remoteOpenedAt: at,
            remoteVerifiedAt: at,
          },
        },
        result: null,
      }),
    ),
  );
  const consent = await owner.patientConsent.findFirstOrThrow({
    where: { signatureRequestId: id },
  });
  return { requestId: id, consentId: consent.id };
}

const asApp = <T>(
  s: Seeded,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
) => prisma.runWithTenant(s.tenantId, fn);

describe('firma a distancia en Postgres (DX-243)', () => {
  let a: Seeded;
  let b: Seeded;

  beforeAll(async () => {
    await resetDatabase(owner);
    a = await seedClinic('dx243-int-a');
    b = await seedClinic('dx243-int-b');
  });

  afterAll(async () => {
    await resetDatabase(owner);
    await owner.$disconnect();
    await prisma.$disconnect();
  });

  describe('RLS', () => {
    it('el token de A no existe con el tenant de B (ni su solicitud ni su consentimiento)', async () => {
      const { id, token } = await issue(a);
      expect(
        await asClinic(a.tenantId, () =>
          repo.findByTokenHash(hashSignatureToken(token)),
        ),
      ).toMatchObject({
        request: { id },
        location: { timeZone: 'America/Bogota' },
      });
      expect(
        await asClinic(b.tenantId, () =>
          repo.findByTokenHash(hashSignatureToken(token)),
        ),
      ).toBeNull();
      // Ni bloquearla ni escribir en ella desde B.
      expect(
        await asClinic(b.tenantId, () =>
          repo.withLockedRequest(
            id,
            { ipAddress: null, userAgent: null, requestId: null },
            () => ({
              write: { patch: { openedAt: new Date() }, audit: [] },
              result: 'tocada',
            }),
          ),
        ),
      ).toBeNull();
      expect(
        (await owner.signatureRequest.findUniqueOrThrow({ where: { id } }))
          .openedAt,
      ).toBeNull();
      expect(await asClinic(b.tenantId, () => repo.findById(id))).toBeNull();
      expect(
        await asClinic(b.tenantId, () =>
          repo.revoke({ id, revokedById: b.userId, now: new Date() }),
        ),
      ).toBe('NOT_FOUND');
    });

    it('no deja insertar con el tenantId de otra clínica (WITH CHECK)', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.create({
            data: {
              ...requestInput(b, generateSignatureToken()),
              tenantId: b.tenantId,
            },
          }),
        ),
      ).rejects.toThrow(/row-level security/);
    });

    it('RLS forzada en las dos tablas nuevas', async () => {
      const rows = await owner.$queryRaw<
        {
          relname: string;
          relrowsecurity: boolean;
          relforcerowsecurity: boolean;
        }[]
      >`SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('signature_requests', 'patient_consent_countersignatures', 'patient_consents')
        ORDER BY relname`;
      expect(rows).toEqual([
        {
          relname: 'patient_consent_countersignatures',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          relname: 'patient_consents',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
        {
          relname: 'signature_requests',
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ]);
    });
  });

  describe('FK compuestas por tenant', () => {
    const FK = { code: 'P2003' };

    it.each<
      [
        string,
        (s: Seeded, o: Seeded) => Partial<CreateSignatureRequestRepoInput>,
      ]
    >([
      ['el paciente', (_s, o) => ({ patientId: o.patientId })],
      ['la plantilla', (_s, o) => ({ templateId: o.templateId })],
      ['la sede', (_s, o) => ({ locationId: o.locationId })],
      ['el plan', (_s, o) => ({ treatmentPlanId: o.planId })],
    ])('no admite %s de otra clínica', async (_name, extra) => {
      await expect(
        asClinic(a.tenantId, () =>
          repo.create(requestInput(a, generateSignatureToken(), extra(a, b))),
        ),
      ).rejects.toMatchObject(FK);
    });

    it('no admite el plan de otro paciente de la misma clínica', async () => {
      await expect(
        asClinic(a.tenantId, () =>
          repo.create(
            requestInput(a, generateSignatureToken(), {
              patientId: a.otherPatientId,
              treatmentPlanId: a.planId,
            }),
          ),
        ),
      ).rejects.toMatchObject(FK);
    });
  });

  describe('CHECK', () => {
    it('solo hashes en hex: nunca el token ni el código en claro', async () => {
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.create({
            data: {
              ...requestInput(a, 'x'),
              tenantId: a.tenantId,
              tokenHash: generateSignatureToken(),
            },
          }),
        ),
      ).rejects.toThrow(/signature_requests_hash_check/);
      const { id } = await issue(a);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: {
              codeHash: '123456',
              codeExpiresAt: new Date(),
              codeSentAt: new Date(),
              openedAt: new Date(),
            },
          }),
        ),
      ).rejects.toThrow(/signature_requests_hash_check/);
    });

    it('bloqueado ⇔ 5 fallos; nunca más de 5', async () => {
      const { id } = await issue(a);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: { failedAttempts: 5 },
          }),
        ),
      ).rejects.toThrow(/signature_requests_state_check/);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: { failedAttempts: 6, lockedAt: new Date() },
          }),
        ),
      ).rejects.toThrow(/signature_requests_state_check/);
      await asApp(a, (tx) =>
        tx.signatureRequest.update({
          where: { id },
          data: { failedAttempts: 5, lockedAt: new Date() },
        }),
      );
    });

    it('firmar exige haberlo verificado', async () => {
      const { id } = await issue(a);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id },
            data: { signedAt: new Date() },
          }),
        ),
      ).rejects.toThrow(/signature_requests_state_check/);
    });

    it('un consentimiento a distancia lleva todas sus evidencias y no la firma del profesional', async () => {
      const { requestId } = await signed(a);
      const base = await owner.patientConsent.findFirstOrThrow({
        where: { signatureRequestId: requestId },
      });
      const { id: _id, createdAt: _c, ...data } = base;
      await expect(
        asApp(a, (tx) =>
          tx.patientConsent.create({
            data: {
              ...data,
              signatureRequestId: null,
            },
          }),
        ),
      ).rejects.toThrow(/patient_consents_remote_check/);
      // La misma solicitud no produce un segundo consentimiento.
      await expect(
        asApp(a, (tx) =>
          tx.patientConsent.create({
            data: data,
          }),
        ),
      ).rejects.toMatchObject({ code: 'P2002' });
    });
  });

  describe('inmutabilidad', () => {
    it('una solicitud firmada no cambia más, ni su documento ni su token', async () => {
      const { requestId } = await signed(a);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({
            where: { id: requestId },
            data: { revokedAt: new Date(), revokedById: a.userId },
          }),
        ),
      ).rejects.toThrow(/signature_requests/);
      const { id } = await issue(a);
      await expect(
        asApp(a, (tx) =>
          tx.signatureRequest.update({ where: { id }, data: { body: 'otro' } }),
        ),
      ).rejects.toThrow(/una solicitud firmada o anulada no cambia/);
      expect(
        await asClinic(a.tenantId, () =>
          repo.revoke({
            id: requestId,
            revokedById: a.userId,
            now: new Date(),
          }),
        ),
      ).toBe('NOT_PENDING');
    });

    it('no se borra una solicitud (solo la purga de un superusuario)', async () => {
      const { id } = await issue(a);
      // Con SQL: la app ni siquiera tiene `delete` (no-hard-delete.ts); esto
      // prueba la red de la base.
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "signature_requests" WHERE "id" = ${id}::uuid`,
        ),
      ).rejects.toThrow(/inalterable/);
    });

    it('el consentimiento firmado a distancia es inmutable y la firma del profesional, también', async () => {
      const { consentId } = await signed(a);
      await expect(
        asApp(a, (tx) =>
          tx.patientConsent.update({
            where: { id: consentId },
            data: { body: 'x' },
          }),
        ),
      ).rejects.toThrow(/inmutable/);
      const counter = await asApp(a, (tx) =>
        tx.patientConsentCountersignature.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            consentId,
            professionalUserId: a.userId,
            professionalName: 'Dra.',
            professionalSignature: PNG,
            contentHash: HASH,
            signedAt: new Date(),
          },
        }),
      );
      await expect(
        asApp(a, (tx) =>
          tx.patientConsentCountersignature.update({
            where: { id: counter.id },
            data: { professionalName: 'Otro' },
          }),
        ),
      ).rejects.toThrow(/inalterable/);
      await expect(
        asApp(
          a,
          (tx) =>
            tx.$executeRaw`DELETE FROM "patient_consent_countersignatures" WHERE "id" = ${counter.id}::uuid`,
        ),
      ).rejects.toThrow(/inalterable/);
      // Una segunda firma del profesional no cabe.
      await expect(
        asApp(a, (tx) =>
          tx.patientConsentCountersignature.create({
            data: {
              tenantId: a.tenantId,
              patientId: a.patientId,
              consentId,
              professionalUserId: a.userId,
              professionalName: 'Dra.',
              professionalSignature: PNG,
              contentHash: HASH,
              signedAt: new Date(),
            },
          }),
        ),
      ).rejects.toThrow();
    });

    it('la firma del profesional solo completa uno a distancia, del mismo paciente y clínica', async () => {
      const onScreen = await asApp(a, (tx) =>
        tx.patientConsent.create({
          data: {
            tenantId: a.tenantId,
            patientId: a.patientId,
            templateId: a.templateId,
            templateVersion: 1,
            title: 'Exodoncia',
            body: 'Texto',
            signerType: 'PATIENT',
            signerName: 'Ana',
            professionalName: 'Dra.',
            patientSignature: PNG,
            professionalSignature: PNG,
            contentHash: HASH,
            signedAt: new Date(),
            recordedById: a.userId,
          },
        }),
      );
      const counter = (s: Seeded, consentId: string, patientId = s.patientId) =>
        asApp(s, (tx) =>
          tx.patientConsentCountersignature.create({
            data: {
              tenantId: s.tenantId,
              patientId,
              consentId,
              professionalUserId: s.userId,
              professionalName: 'Dra.',
              professionalSignature: PNG,
              contentHash: HASH,
              signedAt: new Date(),
            },
          }),
        );
      await expect(counter(a, onScreen.id)).rejects.toThrow(
        /solo se añade a un consentimiento firmado a distancia/,
      );
      const { consentId } = await signed(a);
      await expect(counter(a, consentId, a.otherPatientId)).rejects.toThrow();
      await expect(counter(b, consentId)).rejects.toThrow();
    });
  });

  describe('auditoría del paciente', () => {
    it('los pasos del enlace quedan sin actor, con origen LINK y el paciente', async () => {
      const { requestId } = await signed(a);
      const events = await owner.auditEvent.findMany({
        where: { tenantId: a.tenantId, resourceId: requestId },
      });
      expect(events).toEqual([
        expect.objectContaining({
          action: 'SIGN',
          resourceType: 'SIGNATURE_REQUEST',
          actorUserId: null,
          actorRole: null,
          patientId: a.patientId,
          ip: '203.0.113.7',
          metadata: { origin: 'LINK', reason: 'SIGNATURE_PATIENT_SIGNED' },
        }),
      ]);
    });

    it('la BD no admite otro evento sin actor sobre una solicitud', async () => {
      const { id } = await issue(a);
      await expect(
        owner.auditEvent.create({
          data: {
            tenantId: a.tenantId,
            action: 'DELETE',
            resourceType: 'SIGNATURE_REQUEST',
            resourceId: id,
            patientId: a.patientId,
            metadata: { origin: 'LINK', reason: 'SIGNATURE_PATIENT_SIGNED' },
          },
        }),
      ).rejects.toThrow(/audit_events_actor_check/);
    });
  });
});
