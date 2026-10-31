import { randomUUID } from 'node:crypto';
import type { Prisma, PrismaClient } from '@prisma/client';
import type { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';
import type { PrismaSignatureRequestRepository } from '../../src/modules/signature-requests/infrastructure/prisma-signature-request.repository';
import {
  generateSignatureToken,
  hashSignatureToken,
} from '../../src/modules/signature-requests/domain/signature-token';
import type { PrismaPatientConsentRepository } from '../../src/modules/consents/infrastructure/repositories/prisma-patient-consent.repository';
import {
  computeCountersignatureHash,
  computeRemoteConsentHash,
} from '../../src/modules/consents/domain/consent-hash';
import { REGIONAL_BOGOTA_FIXTURE, locationData } from './location-fixtures';

// Clínica, consentimiento firmado a distancia y firma del profesional contra
// Postgres, para las pruebas de integración del PDF firmado (DX-422) y de su
// copia al paciente (DX-443).

export const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

export interface Seeded {
  tenantId: string;
  locationId: string;
  patientId: string;
  templateId: string;
  userId: string;
}

export function signedConsentFixtures(deps: {
  owner: PrismaClient;
  tenantContext: TenantContextService;
  requests: PrismaSignatureRequestRepository;
  consents: PrismaPatientConsentRepository;
}) {
  const { owner, tenantContext, requests, consents } = deps;

  async function seedClinic(subdomain: string): Promise<Seeded> {
    const tenant = await owner.tenant.create({
      data: { name: `Clínica ${subdomain}`, subdomain },
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
    const patient = await owner.patient.create({
      data: {
        tenantId: tenant.id,
        firstName: 'Ana',
        lastName: 'Int',
        docNumber: randomUUID().slice(0, 12),
      },
    });
    const template = await owner.consentTemplate.create({
      data: { tenantId: tenant.id, title: 'Exodoncia', body: 'Texto' },
    });
    return {
      tenantId: tenant.id,
      locationId: location.id,
      patientId: patient.id,
      templateId: template.id,
      userId: user.id,
    };
  }

  const asClinic = <T>(tenantId: string, fn: () => Promise<T>): Promise<T> =>
    tenantContext.run(tenantId, fn);

  /** Envía, firma (con el hash real) y devuelve el consentimiento a distancia. */
  async function remoteSigned(s: Seeded): Promise<string> {
    const now = new Date();
    const token = generateSignatureToken();
    const { id } = await asClinic(s.tenantId, () =>
      requests.create({
        locationId: s.locationId,
        patientId: s.patientId,
        type: 'CONSENT',
        channel: 'EMAIL',
        templateId: s.templateId,
        templateVersion: 1,
        treatmentPlanId: null,
        title: 'Consentimiento — Exodoncia',
        body: 'Yo, Ana Int, autorizo la exodoncia.\n\nRiesgos: sangrado, ¿dudas? ¡sí!',
        professionalUserId: s.userId,
        professionalName: 'Dra. Int',
        signerType: 'PATIENT',
        signerName: 'Ana Int',
        signerDocument: null,
        destination: 'ana@example.com',
        destinationMasked: 'an***@example.com',
        tokenHash: hashSignatureToken(token),
        expiresAt: new Date(now.getTime() + 72 * 3600_000),
        createdById: s.userId,
        createdAt: now,
      }),
    );
    const at = new Date();
    await asClinic(s.tenantId, () =>
      requests.withLockedRequest(
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
              contentHash: computeRemoteConsentHash({
                title: r.title,
                body: r.body,
                templateVersion: 1,
                signerType: 'PATIENT',
                signerName: r.signerName,
                signerDocument: null,
                professionalName: r.professionalName,
                patientSignature: PNG,
                signedAt: at,
                channel: 'EMAIL',
                destinationMasked: r.destinationMasked,
                sentAt: r.createdAt,
                openedAt: at,
                verifiedAt: at,
                ipAddress: '203.0.113.7',
                userAgent: 'int',
              }),
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
    return consent.id;
  }

  async function countersign(
    s: Seeded,
    consentId: string,
    onCompleted: (tx: Prisma.TransactionClient) => Promise<void> = () =>
      Promise.resolve(),
  ): Promise<void> {
    const consent = await owner.patientConsent.findFirstOrThrow({
      where: { id: consentId },
    });
    const signedAt = new Date();
    await asClinic(s.tenantId, () =>
      consents.countersign(
        {
          patientId: s.patientId,
          consentId,
          professionalUserId: s.userId,
          professionalName: consent.professionalName,
          professionalSignature: PNG,
          contentHash: computeCountersignatureHash({
            consentHash: consent.contentHash,
            professionalName: consent.professionalName,
            professionalSignature: PNG,
            signedAt,
          }),
          signedAt,
          ipAddress: '198.51.100.1',
          userAgent: 'int-pro',
        },
        onCompleted,
      ),
    );
  }

  return { seedClinic, asClinic, remoteSigned, countersign };
}
