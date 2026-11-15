import {
  ConflictException,
  ForbiddenException,
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrescriptionStatus } from '@prisma/client';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { hashPublicLinkToken } from '../../../../shared/public-links/public-link-token';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  DENTIST_ID,
  InMemoryPrescriptionRepository,
  PATIENT_ID,
  TENANT_ID,
} from '../__fixtures__/in-memory-prescriptions';
import type {
  IssuePrescriptionCopyLinkInput,
  PrescriptionCopyLinkRow,
  PrescriptionCopyTarget,
} from '../../domain/ports/prescription-copy-repository.port';
import {
  DEFAULT_PRESCRIPTION_COPY_FOOTER,
  PRESCRIPTION_COPY_EXPIRED_CODE,
} from '../../domain/prescription-copy-link';
import { PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE } from '../../domain/prescription-copy-recipient';
import { IssuePrescriptionUseCase } from './prescriptions.use-cases';
import {
  GetPublicPrescriptionCopyUseCase,
  PRESCRIPTION_COPY_NO_LINK_HOST_MESSAGE,
  PRESCRIPTION_COPY_VOIDED_MESSAGE,
  SendPrescriptionCopyUseCase,
  type PrescriptionCopyEmailSender,
} from './prescription-copies.use-cases';

const NOW = new Date('2026-11-15T15:00:00.000Z');
const LOCATION_ID = '00000000-0000-4000-8000-00000000010c';
const META = { requestId: 'req-1', ip: '203.0.113.9', userAgent: 'jest' };

function target(
  overrides: Partial<PrescriptionCopyTarget> = {},
): PrescriptionCopyTarget {
  return {
    prescriptionId: 'rx-1',
    patientId: PATIENT_ID,
    status: 'ISSUED',
    clinicName: 'Clínica Demo',
    location: {
      id: LOCATION_ID,
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
      phoneRegion: 'VE',
    },
    patient: {
      firstName: 'Ana',
      birthDate: new Date('1990-01-01T00:00:00Z'),
      email: 'ana@correo.com',
      phone: '0412 1234567',
      reminderOptOutAt: null,
      contactChannel: 'EMAIL',
      preferredLanguage: null,
    },
    responsibles: [],
    majorityAge: 18,
    ...overrides,
  };
}

describe('SendPrescriptionCopyUseCase (DX-468)', () => {
  let tenantContext: TenantContextService;
  let issued: IssuePrescriptionCopyLinkInput[];
  let kicked: number;
  let inserted: number;
  let prepared: Parameters<PrescriptionCopyEmailSender['prepare']>[0][];
  let current: PrescriptionCopyTarget | null;
  let issueOutcome: 'ISSUED' | 'VOIDED' | 'NOT_FOUND';
  let base: string | null;
  const assertCanSend = jest.fn((_to: string) => Promise.resolve());
  const email: PrescriptionCopyEmailSender = {
    assertCanSend,
    prepare: jest.fn((input) => {
      prepared.push(input);
      return Promise.resolve({
        insert: () => {
          inserted += 1;
          return Promise.resolve({ id: 'mail-1' });
        },
        kick: () => {
          kicked += 1;
        },
      });
    }),
  };

  beforeEach(() => {
    tenantContext = new TenantContextService();
    issued = [];
    prepared = [];
    kicked = 0;
    inserted = 0;
    current = target();
    issueOutcome = 'ISSUED';
    base = 'https://demo.dentalix.app';
    assertCanSend.mockClear();
  });

  function useCase() {
    return new SendPrescriptionCopyUseCase(
      {
        loadTarget: () => Promise.resolve(current),
        issueLink: async (input) => {
          issued.push(input);
          if (issueOutcome === 'ISSUED') await input.enqueue?.({} as never);
          return { kind: issueOutcome };
        },
      },
      email,
      { forTenant: () => Promise.resolve(base) },
      tenantContext,
      { ttlDays: 30 },
      () => NOW,
    );
  }

  const send = (channel: 'EMAIL' | 'WHATSAPP', allowed?: readonly string[]) =>
    tenantContext.run(
      TENANT_ID,
      undefined,
      () => useCase().execute('rx-1', channel, DENTIST_ID, 'demo.localhost'),
      allowed,
    );

  it('por email: enlace de 30 días (solo el hash), email en la misma transacción y sin token en la respuesta', async () => {
    const sent = await send('EMAIL');
    expect(sent).toEqual({
      channel: 'EMAIL',
      sentAt: NOW,
      expiresAt: new Date('2026-12-15T15:00:00.000Z'),
      destinationMasked: 'an***@correo.com',
      recipientKind: 'PATIENT',
      whatsapp: null,
    });
    expect(issued).toHaveLength(1);
    expect(issued[0]).toMatchObject({
      prescriptionId: 'rx-1',
      patientId: PATIENT_ID,
      channel: 'EMAIL',
      destinationMasked: 'an***@correo.com',
      createdById: DENTIST_ID,
      now: NOW,
    });
    expect(issued[0].tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      to: 'ana@correo.com',
      referenceId: issued[0].id,
      locale: 'es',
      vars: {
        recipientFirstName: 'Ana',
        patientFirstName: null,
        clinicName: 'Clínica Demo',
        expiresAtLabel: '15/12/2026',
      },
    });
    const url = prepared[0].vars.url;
    expect(url).toMatch(
      /^https:\/\/demo\.dentalix\.app\/receta\/copia\/[A-Za-z0-9_-]{43}$/,
    );
    // Solo el hash del token del email llega a la BD.
    expect(hashPublicLinkToken(url.split('/').pop()!)).toBe(
      issued[0].tokenHash,
    );
    expect(inserted).toBe(1);
    expect(kicked).toBe(1);
  });

  it('el email sale en el idioma del paciente si hay catálogo (DX-497)', async () => {
    current = target({
      patient: { ...target().patient, preferredLanguage: 'en-US' },
    });
    await send('EMAIL');
    expect(prepared[0].locale).toBe('en');
  });

  it('por WhatsApp: devuelve el número, el enlace y un texto con la clínica y el enlace, sin nada clínico', async () => {
    const sent = await send('WHATSAPP');
    expect(prepared).toEqual([]);
    expect(sent.destinationMasked).toBe('••• 4567');
    expect(sent.whatsapp).not.toBeNull();
    const { phone, text, url } = sent.whatsapp!;
    expect(phone).toBe('584121234567');
    expect(url).toMatch(/\/receta\/copia\/[A-Za-z0-9_-]{43}$/);
    expect(text).toBe(
      `Hola Ana, le saludamos de Clínica Demo. Aquí tiene la copia de su receta (enlace personal, caduca el 15/12/2026): ${url}`,
    );
    expect(hashPublicLinkToken(url.split('/').pop()!)).toBe(
      issued[0].tokenHash,
    );
  });

  it('un menor: al responsable registrado, nombrando solo al paciente por su nombre de pila', async () => {
    current = target({
      patient: {
        ...target().patient,
        firstName: 'Sofía',
        birthDate: new Date('2016-03-01T00:00:00Z'),
      },
      responsibles: [
        {
          id: 'resp-1',
          name: 'Luis Pérez',
          email: 'luis@correo.com',
          phone: null,
          isPayer: true,
          receivesNotices: true,
        },
      ],
    });
    const sent = await send('EMAIL');
    expect(sent.recipientKind).toBe('RESPONSIBLE');
    expect(prepared[0]).toMatchObject({
      to: 'luis@correo.com',
      vars: { recipientFirstName: 'Luis', patientFirstName: 'Sofía' },
    });
  });

  it('un menor sin responsable con email: 422 y no se crea nada', async () => {
    current = target({
      patient: {
        ...target().patient,
        birthDate: new Date('2016-03-01T00:00:00Z'),
      },
    });
    const err = await send('EMAIL').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnprocessableEntityException);
    expect((err as Error).message).toBe(
      PRESCRIPTION_COPY_MINOR_NO_EMAIL_MESSAGE,
    );
    expect(issued).toEqual([]);
  });

  it('de otra clínica o inexistente: 404', async () => {
    current = null;
    await expect(send('EMAIL')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('sede de la receta no permitida al usuario: 403 antes de tocar nada', async () => {
    await expect(send('EMAIL', ['otra-sede'])).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(issued).toEqual([]);
    expect(assertCanSend).not.toHaveBeenCalled();
  });

  it('receta anulada (antes o durante el envío): 409 y no sale el email', async () => {
    current = target({ status: 'VOIDED' });
    await expect(send('EMAIL')).rejects.toThrow(
      PRESCRIPTION_COPY_VOIDED_MESSAGE,
    );
    expect(issued).toEqual([]);
    current = target();
    issueOutcome = 'VOIDED';
    await expect(send('EMAIL')).rejects.toBeInstanceOf(ConflictException);
    expect(kicked).toBe(0);
  });

  it('sin host seguro para el enlace: 409 sin crear nada', async () => {
    base = null;
    await expect(send('WHATSAPP')).rejects.toThrow(
      PRESCRIPTION_COPY_NO_LINK_HOST_MESSAGE,
    );
    expect(issued).toEqual([]);
  });
});

describe('GetPublicPrescriptionCopyUseCase (DX-468)', () => {
  let rxRepo: InMemoryPrescriptionRepository;
  let tenantContext: TenantContextService;
  let link: PrescriptionCopyLinkRow | null;
  let opened: { prescriptionId: string; locationId: string }[];
  let footer: string | null;
  let rxId: string;
  let now: Date;
  const TOKEN = 'A'.repeat(43);

  beforeEach(async () => {
    rxRepo = new InMemoryPrescriptionRepository();
    tenantContext = new TenantContextService();
    opened = [];
    footer = null;
    now = NOW;
    const rx = await new IssuePrescriptionUseCase(
      rxRepo,
      () => NOW,
      new FixedDocumentTypeNamesReader(),
    ).execute(
      PATIENT_ID,
      {
        items: [
          {
            activeIngredient: 'Ibuprofeno',
            concentration: '400 mg',
            pharmaceuticalForm: 'Comprimido',
            route: 'Oral',
            dose: '1 comprimido',
            frequency: 'Cada 8 horas',
            durationDays: 3,
            totalQuantity: 9,
            quantityUnit: 'comprimidos',
          },
        ],
      },
      DENTIST_ID,
    );
    rxId = rx.id;
    rxRepo.locationFormats.set(rx.locationId, {
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
    link = {
      id: 'link-1',
      prescriptionId: rx.id,
      patientId: PATIENT_ID,
      expiresAt: new Date('2026-12-15T15:00:00.000Z'),
      revokedAt: null,
    };
  });

  function open(token = TOKEN, tenant: string | null = TENANT_ID) {
    const useCase = new GetPublicPrescriptionCopyUseCase(
      {
        findLinkByTokenHash: (hash) =>
          Promise.resolve(hash === hashPublicLinkToken(TOKEN) ? link : null),
        recordOpened: (input) => {
          opened.push(input);
          return Promise.resolve();
        },
        findClinicBranding: () =>
          Promise.resolve({
            name: 'Clínica Demo',
            primaryColor: null,
            logoUrl: null,
          }),
      },
      rxRepo,
      {
        get: () =>
          Promise.resolve({
            printQuantityInWords: false,
            requireClinicalRecordNumber: false,
            validityDays: 30,
            patientCopyFooter: footer,
          }),
      },
      tenantContext,
      () => now,
    );
    return tenant
      ? tenantContext.run(tenant, () => useCase.execute(token, META))
      : useCase.execute(token, META);
  }

  it('vivo: la receta (tras validar el token), el pie por defecto y la apertura auditada', async () => {
    const view = await open();
    expect(view.status).toBe('AVAILABLE');
    if (view.status !== 'AVAILABLE') throw new Error('unreachable');
    expect(view.footer).toBe(DEFAULT_PRESCRIPTION_COPY_FOOTER);
    expect(view.prescription.id).toBe(rxId);
    expect(view.prescription.verificationCode).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    expect(view.prescription.integrityOk).toBe(true);
    expect(opened).toEqual([
      {
        prescriptionId: rxId,
        locationId: rxRepo.rows[0].locationId,
        meta: META,
      },
    ]);
  });

  it('con el pie de la clínica', async () => {
    footer = 'Solo informativa: retire con la receta firmada.';
    const view = await open();
    expect(view.status === 'AVAILABLE' && view.footer).toBe(footer);
  });

  it('anulada después del envío: «anulada», sin receta, y la apertura se audita igual', async () => {
    rxRepo.rows[0].status = PrescriptionStatus.VOIDED;
    rxRepo.rows[0].voidedAt = new Date('2026-11-16T02:00:00.000Z');
    const view = await open();
    expect(view).toEqual({
      status: 'VOIDED',
      clinic: { name: 'Clínica Demo', primaryColor: null, logoUrl: null },
      expiresAt: link!.expiresAt,
      voidedAt: new Date('2026-11-16T02:00:00.000Z'),
      locationFormat: {
        timeZone: 'America/Caracas',
        locale: 'es-VE',
        hourCycle: 'h12',
      },
    });
    expect(opened).toHaveLength(1);
  });

  it('hash alterado: no se muestra la receta', async () => {
    rxRepo.rows[0].patientName = 'Otra Persona';
    await expect(open()).resolves.toMatchObject({ status: 'UNVERIFIABLE' });
  });

  it('caducado: 410 con su código y sin auditar', async () => {
    now = new Date('2026-12-15T15:00:00.000Z');
    const err = await open().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GoneException);
    expect((err as GoneException).getResponse()).toMatchObject({
      code: PRESCRIPTION_COPY_EXPIRED_CODE,
    });
    expect(opened).toEqual([]);
  });

  it.each([
    ['invalidado (reenvío o archivo)', () => (link!.revokedAt = NOW), TOKEN],
    ['inventado', () => undefined, 'B'.repeat(43)],
    ['mal formado', () => undefined, 'corto'],
  ])('%s: el mismo 404 genérico, sin auditar', async (_l, arrange, token) => {
    arrange();
    await expect(open(token)).rejects.toBeInstanceOf(NotFoundException);
    expect(opened).toEqual([]);
  });

  it('sin clínica en el host: 404', async () => {
    await expect(open(TOKEN, null)).rejects.toBeInstanceOf(NotFoundException);
  });
});
