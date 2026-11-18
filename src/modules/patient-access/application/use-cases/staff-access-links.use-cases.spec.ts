import { HttpException } from '@nestjs/common';
import { hashPublicLinkToken } from '../../../../shared/public-links/public-link-token';
import type {
  AccessLinkPatient,
  IssueAccessLinkInput,
  PatientAccessRepository,
} from '../../domain/ports/patient-access-repository.port';
import {
  CreateAccessLinkUseCase,
  RevokeAccessLinkUseCase,
} from './staff-access-links.use-cases';

const NOW = new Date('2026-11-18T15:00:00.000Z');
const LINK = { protocol: 'https', host: 'sonrisa.dentalix.app' };

function setup(
  patient: Partial<AccessLinkPatient> | null = {},
  responsibles: {
    id: string;
    name: string;
    phone: string | null;
    isPayer: boolean;
    receivesNotices: boolean;
  }[] = [],
) {
  const issued: IssueAccessLinkInput[] = [];
  const repo = {
    findPatient: jest.fn(() =>
      Promise.resolve(
        patient === null
          ? null
          : {
              id: 'p1',
              firstName: 'Luis Alberto',
              birthDate: new Date('1985-07-04T00:00:00.000Z'),
              phone: '0412-555-1234',
              deletedAt: null,
              ...patient,
            },
      ),
    ),
    clinicContext: jest.fn(() =>
      Promise.resolve({
        clinicName: 'Clínica Sonrisa Caracas',
        phoneRegion: 'VE',
        location: { id: 'l1', locale: 'es-VE', hourCycle: 'h12' },
        majorityAge: 18,
        timeZone: 'America/Caracas',
      }),
    ),
    responsibles: jest.fn(() => Promise.resolve(responsibles)),
    issue: jest.fn((input: IssueAccessLinkInput) => {
      issued.push(input);
      return Promise.resolve();
    }),
    revoke: jest.fn(() => Promise.resolve('REVOKED')),
  };
  const create = new CreateAccessLinkUseCase(
    repo as unknown as PatientAccessRepository,
    () => NOW,
  );
  return { create, repo, issued };
}

async function errorOf(p: Promise<unknown>) {
  try {
    await p;
  } catch (e) {
    const err = e as HttpException;
    return { status: err.getStatus(), body: err.getResponse() };
  }
  throw new Error('no falló');
}

describe('CreateAccessLinkUseCase (DX-101)', () => {
  it('guarda solo el hash; la URL con el token solo va en la respuesta', async () => {
    const { create, issued } = setup();
    const out = await create.execute(
      'p1',
      { scopes: ['ACCOUNT', 'APPOINTMENTS', 'ACCOUNT'] },
      'u1',
      LINK,
    );
    const token = out.url.split('/mi-clinica/')[1];
    expect(out.url).toBe(`https://sonrisa.dentalix.app/mi-clinica/${token}`);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(issued).toHaveLength(1);
    expect(issued[0].tokenHash).toBe(hashPublicLinkToken(token));
    expect(JSON.stringify(issued[0])).not.toContain(token);
    expect(issued[0].scopes).toEqual(['APPOINTMENTS', 'ACCOUNT']);
    expect(issued[0].createdById).toBe('u1');
    // 14 días por defecto.
    expect(out.expiresAt).toEqual(new Date('2026-12-02T15:00:00.000Z'));
    expect(out.minor).toBe(false);
  });

  it('WhatsApp con el número venezolano y sin importes', async () => {
    const { create } = setup();
    const out = await create.execute(
      'p1',
      { scopes: ['ACCOUNT'], ttlDays: 7 },
      'u1',
      LINK,
    );
    expect(out.whatsapp?.phone).toBe('584125551234');
    expect(out.whatsapp?.text).toContain('Hola Luis');
    expect(out.whatsapp?.text).toContain('tu estado de cuenta');
    expect(out.whatsapp?.text).toContain(out.url);
    expect(out.expiresAt).toEqual(new Date('2026-11-25T15:00:00.000Z'));
  });

  it('sin teléfono válido, whatsapp es null', async () => {
    const { create } = setup({ phone: null });
    const out = await create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK);
    expect(out.whatsapp).toBeNull();
  });

  it('menor con responsable con teléfono: el WhatsApp va al responsable y lo dice', async () => {
    const { create } = setup(
      { birthDate: new Date('2015-01-10T00:00:00.000Z') },
      [
        {
          id: 'r1',
          name: 'Ana Rondón',
          phone: '0414-555-0202',
          isPayer: true,
          receivesNotices: true,
        },
      ],
    );
    const out = await create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK);
    expect(out.minor).toBe(true);
    expect(out.whatsapp).toMatchObject({
      phone: '584145550202',
      recipient: { kind: 'RESPONSIBLE', name: 'Ana Rondón' },
    });
    expect(out.whatsapp?.text).toContain('Hola Ana');
    expect(out.whatsapp?.text).toContain('los presupuestos de Luis');
  });

  it('menor sin responsable: al teléfono del paciente', async () => {
    const { create, repo } = setup({
      birthDate: new Date('2015-01-10T00:00:00.000Z'),
    });
    const out = await create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK);
    expect(repo.responsibles).toHaveBeenCalledWith('p1');
    expect(out.whatsapp).toMatchObject({
      phone: '584125551234',
      recipient: { kind: 'PATIENT', name: null },
    });
  });

  it('adulto: ni se consultan los responsables', async () => {
    const { create, repo } = setup();
    const out = await create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK);
    expect(repo.responsibles).not.toHaveBeenCalled();
    expect(out.whatsapp?.recipient).toEqual({ kind: 'PATIENT', name: null });
  });

  it('un menor de edad lo marca para el aviso al personal', async () => {
    const { create } = setup({
      birthDate: new Date('2015-01-10T00:00:00.000Z'),
    });
    const out = await create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK);
    expect(out.minor).toBe(true);
  });

  it('sin fecha de nacimiento (el segundo factor): 409 con code, sin enlace', async () => {
    const { create, repo } = setup({ birthDate: null });
    const err = await errorOf(
      create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK),
    );
    expect(err).toMatchObject({
      status: 409,
      body: { code: 'PATIENT_ACCESS_NO_BIRTH_DATE' },
    });
    expect(repo.issue).not.toHaveBeenCalled();
  });

  it('archivado: 409; inexistente: 404; host manipulado: 400', async () => {
    expect(
      (
        await errorOf(
          setup({ deletedAt: NOW }).create.execute(
            'p1',
            { scopes: ['PLANS'] },
            'u1',
            LINK,
          ),
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await errorOf(
          setup(null).create.execute('p1', { scopes: ['PLANS'] }, 'u1', LINK),
        )
      ).status,
    ).toBe(404);
    const { create, repo } = setup();
    expect(
      (
        await errorOf(
          create.execute('p1', { scopes: ['PLANS'] }, 'u1', {
            protocol: 'https',
            host: null,
          }),
        )
      ).status,
    ).toBe(400);
    expect(repo.issue).not.toHaveBeenCalled();
  });
});

describe('RevokeAccessLinkUseCase (DX-101)', () => {
  it('revocar es idempotente; uno de otro paciente o clínica es 404', async () => {
    const repo = {
      revoke: jest
        .fn()
        .mockResolvedValueOnce('REVOKED')
        .mockResolvedValueOnce('ALREADY_REVOKED')
        .mockResolvedValueOnce('NOT_FOUND'),
    };
    const revoke = new RevokeAccessLinkUseCase(
      repo as unknown as PatientAccessRepository,
    );
    const audit = {
      tenantId: 't1',
      locationId: null,
      actor: { userId: 'u1', role: 'RECEPTION' as const },
      requestId: 'r1',
      ip: null,
      userAgent: null,
    };
    await expect(revoke.execute('p1', 'l1', audit)).resolves.toBeUndefined();
    await expect(revoke.execute('p1', 'l1', audit)).resolves.toBeUndefined();
    expect((await errorOf(revoke.execute('p1', 'l9', audit))).status).toBe(404);
    expect(repo.revoke).toHaveBeenCalledWith('p1', 'l1', audit);
  });
});
