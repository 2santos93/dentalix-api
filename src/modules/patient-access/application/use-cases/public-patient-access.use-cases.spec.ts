import { HttpException } from '@nestjs/common';
import type { PatientAccessScope } from '@prisma/client';
import { hashPublicLinkToken } from '../../../../shared/public-links/public-link-token';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AccountStatement } from '../../../account-statement/domain/entities/account-statement.entity';
import {
  PATIENT_ACCESS_FAILURE_FLOOR_MS,
  type VerifyDecision,
} from '../../domain/patient-access';
import {
  derivePatientAccessSessionKey,
  verifyPatientAccessSession,
} from '../../domain/patient-access-session';
import type {
  PatientAccessRepository,
  SessionLink,
  VerifyAttemptOutcome,
} from '../../domain/ports/patient-access-repository.port';
import { UnknownTokenAttempts } from '../unknown-token-attempts';
import {
  ConfirmPortalAppointmentUseCase,
  GetPatientPortalUseCase,
  VerifyPatientAccessUseCase,
  forPatient,
  type PatientAccessPrincipal,
} from './public-patient-access.use-cases';

const TENANT = '11111111-1111-4111-8111-111111111111';
const LINK_ID = '33333333-3333-4333-8333-333333333333';
const PATIENT = '44444444-4444-4444-8444-444444444444';
const TOKEN = 'A'.repeat(43);
const NOW = new Date('2026-11-18T15:00:00.000Z');
const KEY = derivePatientAccessSessionKey('secreto-de-prueba-0123456789abcdef');
const META = { requestId: 'r1', ip: '203.0.113.9', userAgent: 'jest' };

interface FakeLink {
  failedAttempts: number;
  lockedUntil: Date | null;
  birthDate: Date | null;
  scopes: PatientAccessScope[];
  expiresAt: Date;
}

/**
 * Repositorio en memoria que imita el FOR UPDATE: las verificaciones del
 * mismo enlace se encadenan (una espera a que la anterior escriba).
 */
function fakeRepo(
  links: Map<string, FakeLink>,
  tenantContext: TenantContextService,
) {
  let chain: Promise<unknown> = Promise.resolve();
  const evaluated: string[] = [];
  const repo = {
    verifyAttempt: jest.fn(
      (
        tokenHash: string,
        decide: (s: {
          failedAttempts: number;
          lockedUntil: Date | null;
          birthDate: Date | null;
          dbNow: Date;
        }) => VerifyDecision,
      ): Promise<VerifyAttemptOutcome> => {
        const run = chain.then(async () => {
          await new Promise((r) => setImmediate(r));
          // La RLS: solo los enlaces de la clínica del contexto.
          const link = links.get(`${tenantContext.getTenantId()}:${tokenHash}`);
          if (!link) return { kind: 'NO_LINK' } as const;
          const decision = decide({ ...link, dbNow: NOW });
          evaluated.push(decision.kind);
          if (decision.kind === 'OK') {
            link.failedAttempts = 0;
            link.lockedUntil = null;
          } else if (decision.kind === 'WRONG') {
            link.failedAttempts = decision.failedAttempts;
          } else if (decision.kind === 'LOCK') {
            link.failedAttempts = decision.failedAttempts;
            link.lockedUntil = decision.lockedUntil;
          }
          return {
            kind: 'DECIDED',
            linkId: LINK_ID,
            patientId: PATIENT,
            decision,
          } as const;
        });
        chain = run.catch(() => undefined);
        return run;
      },
    ),
    findSessionLink: jest.fn((): Promise<SessionLink | null> =>
      Promise.resolve({
        id: LINK_ID,
        patientId: PATIENT,
        scopes: [
          ...(links.get(`${TENANT}:${hashPublicLinkToken(TOKEN)}`)?.scopes ??
            []),
        ],
        expiresAt: links.get(`${TENANT}:${hashPublicLinkToken(TOKEN)}`)!
          .expiresAt,
        revokedAt: null,
        patientArchived: false,
      }),
    ),
  };
  return { repo, evaluated };
}

function setup(link: Partial<FakeLink> | null = {}) {
  const links = new Map<string, FakeLink>();
  if (link) {
    links.set(`${TENANT}:${hashPublicLinkToken(TOKEN)}`, {
      failedAttempts: 0,
      lockedUntil: null,
      birthDate: new Date('1990-05-21T00:00:00.000Z'),
      scopes: ['APPOINTMENTS', 'ACCOUNT'],
      expiresAt: new Date(NOW.getTime() + 14 * 86_400_000),
      ...link,
    });
  }
  const tenantContext = new TenantContextService();
  const { repo, evaluated } = fakeRepo(links, tenantContext);
  const sleep = jest.fn((_ms: number) => Promise.resolve());
  const unknown = new UnknownTokenAttempts();
  const useCase = new VerifyPatientAccessUseCase(
    tenantContext,
    repo as unknown as PatientAccessRepository,
    unknown,
    KEY,
    () => NOW,
    sleep,
  );
  const verify = (token: string, birthDate: unknown, tenant = TENANT) =>
    tenantContext.run(tenant, () => useCase.execute(token, birthDate, META));
  return { verify, repo, sleep, links, evaluated, unknown };
}

async function statusOf(p: Promise<unknown>): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  try {
    await p;
    return { status: 200, body: {} };
  } catch (e) {
    const err = e as HttpException;
    return {
      status: err.getStatus(),
      body: err.getResponse() as Record<string, unknown>,
    };
  }
}

describe('VerifyPatientAccessUseCase (DX-101)', () => {
  it('con la fecha correcta abre una sesión de 30 min firmada para ESTA clínica', async () => {
    const { verify, sleep } = setup();
    const result = await verify(TOKEN, '1990-05-21');
    expect(result.scopes).toEqual(['APPOINTMENTS', 'ACCOUNT']);
    expect(result.sessionExpiresAt).toEqual(
      new Date(NOW.getTime() + 30 * 60_000),
    );
    expect(
      verifyPatientAccessSession(KEY, TENANT, result.cookieValue, NOW),
    ).toEqual({ linkId: LINK_ID, expiresAt: result.sessionExpiresAt });
    // El acierto no espera el suelo.
    expect(sleep).not.toHaveBeenCalled();
  });

  it('la sesión nunca dura más que el enlace', async () => {
    const expiresAt = new Date(NOW.getTime() + 5 * 60_000);
    const { verify } = setup({ expiresAt });
    expect((await verify(TOKEN, '1990-05-21')).sessionExpiresAt).toEqual(
      expiresAt,
    );
  });

  it('fecha errónea: 400 «Datos incorrectos», con el suelo de tiempo', async () => {
    const { verify, sleep } = setup();
    const res = await statusOf(verify(TOKEN, '1990-05-22'));
    expect(res).toEqual({
      status: 400,
      body: expect.objectContaining({
        code: 'PATIENT_ACCESS_INVALID',
        message: 'Datos incorrectos',
      }),
    });
    expect(sleep).toHaveBeenCalledTimes(1);
    const [ms] = sleep.mock.calls[0];
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(PATIENT_ACCESS_FAILURE_FLOOR_MS);
  });

  it('sin enumeración: token desconocido, malformado, de otra clínica o fecha basura responden IGUAL', async () => {
    const { verify } = setup();
    const known = await statusOf(verify(TOKEN, '1990-05-22'));
    const others = await Promise.all([
      statusOf(verify('B'.repeat(43), '1990-05-21')),
      statusOf(verify('corto', '1990-05-21')),
      statusOf(
        verify(TOKEN, '1990-05-21', '99999999-9999-4999-8999-999999999999'),
      ),
      statusOf(verify(TOKEN, 'no es una fecha')),
      statusOf(verify(TOKEN, 12345)),
    ]);
    for (const res of others) expect(res).toEqual(known);
  });

  it('al quinto fallo, 429 en español con retryAfterSeconds; durante el bloqueo, 429 aunque acierte', async () => {
    const { verify, links } = setup();
    for (let i = 0; i < 4; i++) {
      expect((await statusOf(verify(TOKEN, '2000-01-01'))).status).toBe(400);
    }
    const fifth = await statusOf(verify(TOKEN, '2000-01-01'));
    expect(fifth).toEqual({
      status: 429,
      body: expect.objectContaining({
        code: 'PATIENT_ACCESS_LOCKED',
        message: expect.stringMatching(/bloqueado 30 minutos/),
        retryAfterSeconds: 1800,
      }),
    });
    expect(
      links.get(`${TENANT}:${hashPublicLinkToken(TOKEN)}`)!.failedAttempts,
    ).toBe(5);
    expect((await statusOf(verify(TOKEN, '1990-05-21'))).status).toBe(429);
  });

  it('un token que no existe también da 429 al quinto intento (no revela si existe)', async () => {
    const { verify } = setup(null);
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) {
      statuses.push((await statusOf(verify(TOKEN, '1990-05-21'))).status);
    }
    expect(statuses).toEqual([400, 400, 400, 400, 429, 429]);
  });

  it('N verificaciones en paralelo nunca evalúan más de 5 fechas: el resto, 429', async () => {
    const { verify, evaluated } = setup();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => statusOf(verify(TOKEN, '2000-01-01'))),
    );
    const counts = results.reduce<Record<number, number>>((acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts).toEqual({ 400: 4, 429: 8 });
    expect(evaluated.filter((k) => k === 'WRONG' || k === 'LOCK')).toHaveLength(
      5,
    );
  });

  it('un acierto vuelve el contador a cero', async () => {
    const { verify, links } = setup({ failedAttempts: 3 });
    await verify(TOKEN, '1990-05-21');
    expect(
      links.get(`${TENANT}:${hashPublicLinkToken(TOKEN)}`)!.failedAttempts,
    ).toBe(0);
  });

  it('sin clínica en el host no toca la base', async () => {
    const { repo } = setup();
    const tenantContext = new TenantContextService();
    const useCase = new VerifyPatientAccessUseCase(
      tenantContext,
      repo as unknown as PatientAccessRepository,
      new UnknownTokenAttempts(),
      KEY,
      () => NOW,
      () => Promise.resolve(),
    );
    expect(
      (await statusOf(useCase.execute(TOKEN, '1990-05-21', META))).status,
    ).toBe(400);
    expect(repo.verifyAttempt).not.toHaveBeenCalled();
  });
});

function statement(): AccountStatement {
  return {
    movements: [
      {
        id: 'm1',
        amount: 40.15,
        currency: 'USD',
        createdById: 'u-staff',
        canVoid: true,
        voidBlockedReason: 'NOT_SAME_DAY',
        periodLocked: true,
        voided: true,
        voidedAt: NOW,
        voidedBy: { id: 'u-admin', fullName: 'Admin Clínica' },
        voidReason: 'error de caja interno',
      },
    ],
    summary: [{ currency: 'USD', balance: 59.85 }],
  } as unknown as AccountStatement;
}

describe('forPatient (DX-101): el estado de cuenta del personal sin lo interno', () => {
  it('mismos importes; sin quién registró o anuló, ni motivo interno, ni anular', () => {
    const out = forPatient(statement());
    expect(out.summary).toEqual([{ currency: 'USD', balance: 59.85 }]);
    expect(out.movements[0]).toMatchObject({
      amount: 40.15,
      voided: true,
      voidedAt: NOW,
      createdById: null,
      canVoid: false,
      voidBlockedReason: null,
      periodLocked: false,
      voidedBy: null,
      voidReason: null,
    });
  });
});

describe('GetPatientPortalUseCase (DX-101): solo lo compartido y solo del paciente', () => {
  function portal(scopes: PatientAccessScope[]) {
    const repo = {
      portalPatient: jest.fn(() =>
        Promise.resolve({
          firstName: 'María José',
          birthDate: new Date('2012-03-01T00:00:00.000Z'),
        }),
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
      upcomingAppointments: jest.fn(() =>
        Promise.resolve([
          { id: 'a1', status: 'SCHEDULED' },
          { id: 'a2', status: 'CONFIRMED' },
        ]),
      ),
      sharedPlans: jest.fn(() =>
        Promise.resolve([
          {
            id: 'p1',
            status: 'PRESENTED',
            optionGroupId: 'p1',
            optionLabel: 'A',
          },
        ]),
      ),
    };
    const getQuote = {
      execute: jest.fn(() => Promise.resolve({ planId: 'p1' })),
    };
    const getStatement = {
      execute: jest.fn(() => Promise.resolve(statement())),
    };
    const useCase = new GetPatientPortalUseCase(
      repo as unknown as PatientAccessRepository,
      getQuote as never,
      getStatement as never,
      () => NOW,
    );
    const principal: PatientAccessPrincipal = {
      linkId: LINK_ID,
      patientId: PATIENT,
      scopes,
      sessionExpiresAt: NOW,
    };
    return { useCase, principal, repo, getQuote, getStatement };
  }

  it('un apartado no compartido es null y no se consulta', async () => {
    const { useCase, principal, repo, getQuote, getStatement } = portal([
      'APPOINTMENTS',
    ]);
    const view = await useCase.execute(principal);
    expect(view.appointments).toEqual([
      { id: 'a1', status: 'SCHEDULED', confirmable: true },
      { id: 'a2', status: 'CONFIRMED', confirmable: false },
    ]);
    expect(view.plans).toBeNull();
    expect(view.account).toBeNull();
    expect(getQuote.execute).not.toHaveBeenCalled();
    expect(getStatement.execute).not.toHaveBeenCalled();
    expect(repo.upcomingAppointments).toHaveBeenCalledWith(PATIENT, NOW);
  });

  it('presupuestos y cuenta del paciente del enlace, con el estado de cuenta saneado', async () => {
    const { useCase, principal, getQuote, getStatement, repo } = portal([
      'PLANS',
      'ACCOUNT',
    ]);
    const view = await useCase.execute(principal);
    expect(repo.upcomingAppointments).not.toHaveBeenCalled();
    expect(view.appointments).toBeNull();
    expect(getQuote.execute).toHaveBeenCalledWith(PATIENT, 'p1');
    expect(view.plans).toEqual([
      {
        id: 'p1',
        status: 'PRESENTED',
        optionGroupId: 'p1',
        optionLabel: 'A',
        quote: { planId: 'p1' },
      },
    ]);
    expect(getStatement.execute).toHaveBeenCalledWith(
      PATIENT,
      {},
      expect.objectContaining({ role: 'ASSISTANT' }),
    );
    expect(view.account!.movements[0].canVoid).toBe(false);
    expect(view.account!.movements[0].voidedBy).toBeNull();
  });

  it('solo el nombre de pila; menor de edad según la clínica', async () => {
    const { useCase, principal } = portal(['APPOINTMENTS']);
    const view = await useCase.execute(principal);
    expect(view.patientFirstName).toBe('María');
    expect(view.minor).toBe(true);
    expect(view.clinicName).toBe('Clínica Sonrisa Caracas');
  });
});

describe('ConfirmPortalAppointmentUseCase (DX-101): el flujo de DX-005 sin exponer su token', () => {
  function confirmSetup(
    mine: boolean,
    scopes: PatientAccessScope[] = ['APPOINTMENTS'],
  ) {
    const repo = {
      findConfirmableAppointment: jest.fn(() => Promise.resolve(mine)),
    };
    const create = {
      execute: jest.fn(() => Promise.resolve({ token: 'tok-confirmacion' })),
    };
    const respond = { execute: jest.fn(() => Promise.resolve({})) };
    const useCase = new ConfirmPortalAppointmentUseCase(
      repo as unknown as PatientAccessRepository,
      create as never,
      respond as never,
      () => NOW,
    );
    const principal: PatientAccessPrincipal = {
      linkId: LINK_ID,
      patientId: PATIENT,
      scopes,
      sessionExpiresAt: NOW,
    };
    return { useCase, principal, repo, create, respond };
  }

  it('emite un enlace automático y responde confirm con él; no devuelve el token', async () => {
    const { useCase, principal, create, respond, repo } = confirmSetup(true);
    const out = await useCase.execute(principal, 'a1', META);
    expect(out).toEqual({ status: 'CONFIRMED' });
    expect(JSON.stringify(out)).not.toContain('tok-confirmacion');
    expect(repo.findConfirmableAppointment).toHaveBeenCalledWith(
      PATIENT,
      'a1',
      NOW,
    );
    expect(create.execute).toHaveBeenCalledWith({
      appointmentId: 'a1',
      automatic: true,
    });
    expect(respond.execute).toHaveBeenCalledWith(
      'tok-confirmacion',
      'confirm',
      {},
      META,
    );
  });

  it('una cita de otro paciente (o pasada, o ya confirmada) es 404 sin tocar nada', async () => {
    const { useCase, principal, create } = confirmSetup(false);
    expect(
      (await statusOf(useCase.execute(principal, 'a9', META))).status,
    ).toBe(404);
    expect(create.execute).not.toHaveBeenCalled();
  });

  it('sin el apartado de citas, 404', async () => {
    const { useCase, principal, repo } = confirmSetup(true, ['ACCOUNT']);
    expect(
      (await statusOf(useCase.execute(principal, 'a1', META))).status,
    ).toBe(404);
    expect(repo.findConfirmableAppointment).not.toHaveBeenCalled();
  });
});
