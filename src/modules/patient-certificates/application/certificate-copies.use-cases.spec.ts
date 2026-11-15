import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import {
  generatePublicLinkToken,
  hashPublicLinkToken,
} from '../../../shared/public-links/public-link-token';
import type { PatientCertificate } from '../domain/patient-certificate';
import type { CertificateCopyTarget } from '../infrastructure/prisma-certificate-copy.repository';
import {
  GetPublicCertificateCopyUseCase,
  SendCertificateCopyUseCase,
} from './certificate-copies.use-cases';

const NOW = new Date('2026-11-16T15:00:00Z');

const target = (
  over: Partial<CertificateCopyTarget> = {},
): CertificateCopyTarget => ({
  certificateId: 'c1',
  patientId: 'p1',
  locationId: 'loc',
  voided: false,
  clinicName: 'Clínica Ávila',
  location: {
    id: 'loc',
    timeZone: 'America/Caracas',
    locale: 'es-VE',
    hourCycle: 'h12',
    phoneRegion: 'VE',
  },
  patient: {
    firstName: 'Mariela',
    birthDate: new Date('1985-06-20'),
    email: null,
    phone: '+584121234567',
    reminderOptOutAt: null,
    contactChannel: 'WHATSAPP',
    preferredLanguage: null,
  },
  responsibles: [],
  majorityAge: 18,
  ...over,
});

const cert = (over: Partial<PatientCertificate> = {}): PatientCertificate =>
  ({
    id: 'c1',
    patientId: 'p1',
    locationId: 'loc',
    issuedById: 'u-dentist',
    kind: 'REST',
    number: 3,
    diagnosis: null,
    voidedAt: null,
    ...over,
  }) as PatientCertificate;

function sendWith(
  t: CertificateCopyTarget | null,
  c: PatientCertificate | null,
) {
  const issueLink = jest.fn().mockResolvedValue('ISSUED');
  const useCase = new SendCertificateCopyUseCase(
    {
      loadTarget: () => Promise.resolve(t),
      issueLink,
      findLinkByTokenHash: jest.fn(),
      recordPublicAccess: jest.fn(),
      findClinicBranding: jest.fn(),
    },
    { get: () => Promise.resolve(c) },
    { forTenant: () => Promise.resolve('https://avila.dentalix.app') },
    { getTenantId: () => 't1', assertLocationAllowed: () => undefined },
    { ttlDays: 30 },
    () => NOW,
  );
  return { useCase, issueLink };
}

const reception = { userId: 'u-rec', role: ClinicRole.RECEPTION };
const dentist = { userId: 'u-dentist', role: ClinicRole.DENTIST };

describe('SendCertificateCopyUseCase (DX-306)', () => {
  it('crea el enlace (solo el hash) y devuelve wa.me con el texto del certificado', async () => {
    const { useCase, issueLink } = sendWith(target(), cert());
    const sent = await useCase.execute('p1', 'c1', reception);
    expect(sent).toMatchObject({
      destinationMasked: '••• 4567',
      recipientKind: 'PATIENT',
      whatsapp: { phone: '584121234567' },
    });
    expect(sent.whatsapp.text).toContain('el certificado de reposo');
    expect(sent.expiresAt.toISOString()).toBe('2026-12-16T15:00:00.000Z');
    const token = sent.whatsapp.url.split('/').pop()!;
    expect(issueLink).toHaveBeenCalledWith(
      expect.objectContaining({ tokenHash: hashPublicLinkToken(token) }),
    );
    expect(JSON.stringify(issueLink.mock.calls)).not.toContain(token);
  });

  it('recepción no envía un reposo con diagnóstico (403); quien lo emitió sí', async () => {
    const withDx = cert({ diagnosis: 'Alveolitis' });
    await expect(
      sendWith(target(), withDx).useCase.execute('p1', 'c1', reception),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      sendWith(target(), withDx).useCase.execute('p1', 'c1', dentist),
    ).resolves.toBeDefined();
  });

  it('anulado 409, inexistente 404, sin teléfono 422 que habla del certificado', async () => {
    await expect(
      sendWith(target({ voided: true }), cert()).useCase.execute(
        'p1',
        'c1',
        dentist,
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      sendWith(null, null).useCase.execute('p1', 'c1', dentist),
    ).rejects.toBeInstanceOf(NotFoundException);
    const noPhone = target({
      patient: { ...target().patient, phone: null },
    });
    await expect(
      sendWith(noPhone, cert()).useCase.execute('p1', 'c1', dentist),
    ).rejects.toThrow(
      new UnprocessableEntityException(
        'El paciente no tiene un teléfono que sirva para WhatsApp: escríbelo en su ficha con + y su prefijo, o entrégale el certificado impreso.',
      ),
    );
  });
});

describe('GetPublicCertificateCopyUseCase (DX-306)', () => {
  const token = generatePublicLinkToken();
  const make = (link: { expiresAt: Date; revokedAt: Date | null } | null) => {
    const recordPublicAccess = jest.fn().mockResolvedValue(undefined);
    const useCase = new GetPublicCertificateCopyUseCase(
      {
        loadTarget: jest.fn(),
        issueLink: jest.fn(),
        findLinkByTokenHash: () =>
          Promise.resolve(
            link && { certificateId: 'c1', patientId: 'p1', ...link },
          ),
        recordPublicAccess,
        findClinicBranding: () =>
          Promise.resolve({ name: 'Ávila', primaryColor: null, logoUrl: null }),
      },
      { get: () => Promise.resolve(cert({ voidedAt: new Date() })) },
      { render: () => Promise.resolve(Buffer.from('%PDF')) },
      { getTenantId: () => 't1' },
      () => NOW,
    );
    return { useCase, recordPublicAccess };
  };
  const meta = { requestId: null, ip: null, userAgent: null };

  it('caducado 410, invalidado o inventado 404', async () => {
    await expect(
      make({ expiresAt: NOW, revokedAt: null }).useCase.view(token, meta),
    ).rejects.toBeInstanceOf(GoneException);
    await expect(
      make({ expiresAt: new Date('2027-01-01'), revokedAt: NOW }).useCase.view(
        token,
        meta,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(make(null).useCase.view(token, meta)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(
      make(null).useCase.view('mal-formado', meta),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('anulado: VOIDED (auditado) y sin descarga', async () => {
    const { useCase, recordPublicAccess } = make({
      expiresAt: new Date('2027-01-01'),
      revokedAt: null,
    });
    await expect(useCase.view(token, meta)).resolves.toMatchObject({
      status: 'VOIDED',
    });
    expect(recordPublicAccess).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'VIEW', certificateId: 'c1' }),
    );
    await expect(useCase.pdf(token, meta)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
