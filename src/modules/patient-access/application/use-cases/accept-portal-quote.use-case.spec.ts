import { ConflictException, HttpException } from '@nestjs/common';
import type { PatientAccessScope } from '@prisma/client';
import { signaturePng } from '../../../../../test/support/png-fixtures';
import { quoteSource } from '../../../treatment-plans/application/use-cases/__fixtures__/in-memory-plan-quote.repository';
import {
  composeQuoteContent,
  quoteValidityOf,
} from '../../../treatment-plans/application/use-cases/plan-quote.use-cases';
import {
  computeAcceptanceHash,
  computeQuoteHash,
} from '../../../treatment-plans/domain/plan-quote';
import type { PlanQuoteSource } from '../../../treatment-plans/domain/ports/plan-quote-repository.port';
import type {
  PatientAccessRepository,
  PortalAcceptanceInput,
  PortalAcceptanceOutcome,
  PortalAcceptanceSeal,
} from '../../domain/ports/patient-access-repository.port';
import type { PortalAcceptanceEmail } from '../portal-acceptance-email';
import {
  AcceptPortalQuoteUseCase,
  type PatientAccessPrincipal,
  type PortalPlanView,
} from './public-patient-access.use-cases';

const LINK_ID = '33333333-3333-4333-8333-333333333333';
const PATIENT = '44444444-4444-4444-8444-444444444444';
const PLAN = 'plan-1';
const DB_NOW = new Date('2026-11-18T15:00:00.000Z');
const META = { requestId: 'r1', ip: '203.0.113.9', userAgent: 'jest' };
const PNG = signaturePng(120, 40).toString('base64');
const NAMES = {};

/** Plan presentado, con la validez guardada (vence el 30 de noviembre). */
function presented(overrides: Partial<PlanQuoteSource['plan']> = {}) {
  const base = quoteSource();
  return quoteSource({
    plan: {
      ...base.plan,
      id: PLAN,
      status: 'PRESENTED',
      quoteIssuedOn: '2026-10-31',
      quoteValidUntil: '2026-11-30',
      presentedLocationId: 'loc-1',
      ...overrides,
    },
  });
}

/** El hash que mostró el portal (GetPlanQuoteUseCase con la misma regla). */
function shownHash(source: PlanQuoteSource): string {
  return computeQuoteHash(
    composeQuoteContent(source, quoteValidityOf(source, DB_NOW), NAMES),
  );
}

const VIEW: PortalPlanView = {
  id: PLAN,
  status: 'ACCEPTED',
  optionGroupId: null,
  optionLabel: null,
  acceptable: false,
  validUntil: '2026-11-30',
  contentHash: 'a'.repeat(64),
  acceptedAt: DB_NOW,
  quote: {} as PortalPlanView['quote'],
};

interface Setup {
  source?: PlanQuoteSource;
  siblingChosen?: boolean;
  outcome?: PortalAcceptanceOutcome;
  repoError?: Error;
  scopes?: PatientAccessScope[];
  emailFails?: boolean;
}

function setup(opts: Setup = {}) {
  const source = opts.source ?? presented();
  const seals: PortalAcceptanceSeal[] = [];
  const repo = {
    acceptPlan: jest.fn(
      (input: PortalAcceptanceInput): Promise<PortalAcceptanceOutcome> => {
        if (opts.outcome && opts.outcome.kind !== 'ACCEPTED') {
          return Promise.resolve(opts.outcome);
        }
        // Como el repositorio: `decide` con el plan bloqueado; si lanza, nada.
        seals.push(
          input.decide(source, {
            dbNow: DB_NOW,
            siblingChosen: opts.siblingChosen ?? false,
          }),
        );
        if (opts.repoError) return Promise.reject(opts.repoError);
        return Promise.resolve(
          opts.outcome ?? {
            kind: 'ACCEPTED',
            acceptedAt: DB_NOW,
            confirmation: {
              to: 'maria@example.com',
              greetingName: 'María',
              clinicName: 'Clínica Sonrisa Caracas',
              location: {
                id: 'loc-1',
                locale: 'es-VE',
                hourCycle: 'h12',
                timeZone: 'America/Caracas',
              },
            },
          },
        );
      },
    ),
  };
  const names = {
    book: jest.fn(() => Promise.resolve({ forLocation: () => NAMES })),
  };
  const portal = { plan: jest.fn(() => Promise.resolve(VIEW)) };
  const sendBudgetAccepted = jest.fn(() =>
    opts.emailFails
      ? Promise.reject(new Error('outbox caído'))
      : Promise.resolve(),
  );
  const email: PortalAcceptanceEmail = { sendBudgetAccepted };

  const useCase = new AcceptPortalQuoteUseCase(
    repo as unknown as PatientAccessRepository,
    names as never,
    portal as never,
    email,
    'current',
  );
  const principal: PatientAccessPrincipal = {
    linkId: LINK_ID,
    patientId: PATIENT,
    scopes: opts.scopes ?? ['PLANS'],
    sessionExpiresAt: DB_NOW,
  };
  const accept = (body: Partial<Record<string, string>> = {}) =>
    useCase.execute(
      principal,
      PLAN,
      {
        signerName: 'María José Pérez',
        signature: PNG,
        contentHash: shownHash(source),
        ...body,
      },
      META,
    );
  return { useCase, repo, portal, sendBudgetAccepted, seals, accept, source };
}

async function failure(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) {
      return {
        status: error.getStatus(),
        body: error.getResponse() as { code?: string; message?: string },
      };
    }
    throw error;
  }
  throw new Error('se esperaba un error');
}

describe('AcceptPortalQuoteUseCase (DX-101-bis)', () => {
  it('acepta el presupuesto mostrado: sella la foto viva con la hora de la BD y devuelve el plan del portal', async () => {
    const { accept, seals, source, portal, repo } = setup();
    const view = await accept();
    expect(view).toBe(VIEW);
    const content = composeQuoteContent(
      source,
      quoteValidityOf(source, DB_NOW),
      NAMES,
    );
    const contentHash = computeQuoteHash(content);
    expect(seals).toEqual([
      {
        content,
        contentHash,
        acceptanceHash: computeAcceptanceHash({
          contentHash,
          signerName: 'María José Pérez',
          signature: PNG,
          acceptedAt: DB_NOW,
        }),
      },
    ]);
    expect(repo.acceptPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        linkId: LINK_ID,
        patientId: PATIENT,
        planId: PLAN,
        signerName: 'María José Pérez',
        signature: PNG,
        meta: META,
      }),
    );
    expect(portal.plan).toHaveBeenCalledWith(
      expect.objectContaining({ patientId: PATIENT }),
      PLAN,
    );
  });

  it('recorta el nombre y acepta la firma con prefijo data:', async () => {
    const { accept, repo } = setup();
    await accept({
      signerName: '  María José Pérez  ',
      signature: `data:image/png;base64,${PNG}`,
    });
    expect(repo.acceptPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        signerName: 'María José Pérez',
        signature: PNG,
      }),
    );
  });

  it('sin el apartado de presupuestos: 403 sin tocar la base', async () => {
    const { accept, repo } = setup({ scopes: ['ACCOUNT'] });
    const res = await failure(accept());
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PATIENT_ACCESS_SCOPE_REQUIRED');
    expect(repo.acceptPlan).not.toHaveBeenCalled();
  });

  it.each([
    ['nombre vacío', { signerName: '   ' }],
    ['nombre de más de 120', { signerName: 'a'.repeat(121) }],
    ['firma que no es PNG', { signature: 'aGVsbG8=' }],
    ['firma vacía', { signature: '' }],
  ])('%s: 400 sin tocar la base', async (_name, body) => {
    const { accept, repo } = setup();
    expect((await failure(accept(body))).status).toBe(400);
    expect(repo.acceptPlan).not.toHaveBeenCalled();
  });

  it('plan de otro paciente o inexistente: 404 «No encontramos ese presupuesto.»', async () => {
    const { accept } = setup({ outcome: { kind: 'NOT_FOUND' } });
    const res = await failure(accept());
    expect(res.status).toBe(404);
    expect(res.body.message).toBe('No encontramos ese presupuesto.');
  });

  it('enlace revocado o caducado en la transacción: 410 como el guard', async () => {
    const { accept } = setup({ outcome: { kind: 'GONE' } });
    const res = await failure(accept());
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('PATIENT_ACCESS_GONE');
  });

  const GENERIC = {
    code: 'PORTAL_QUOTE_NOT_ACCEPTABLE',
    message:
      'Este presupuesto ya no se puede aceptar desde aquí. Contacta con la clínica.',
  };

  it.each<[string, Setup]>([
    ['ya aceptado', { source: presented({ status: 'ACCEPTED' }) }],
    ['rechazado', { source: presented({ status: 'REJECTED' }) }],
    ['en borrador', { source: presented({ status: 'DRAFT' }) }],
    // Último día válido el 17 en Caracas; «hoy» es el 18.
    ['vencido', { source: presented({ quoteValidUntil: '2026-11-17' }) }],
    ['otra opción del grupo elegida', { siblingChosen: true }],
    ['sin ítems', { source: { ...presented(), items: [] } }],
  ])('%s: 409 genérico, sin decir por qué', async (_name, opts) => {
    const { accept, seals } = setup(opts);
    const res = await failure(accept());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject(GENERIC);
    expect(seals).toEqual([]);
  });

  it('vence HOY en la sede: todavía se acepta', async () => {
    const { accept } = setup({
      source: presented({ quoteValidUntil: '2026-11-18' }),
    });
    await expect(accept()).resolves.toBe(VIEW);
  });

  it('un 409 de DX-109 (hermana cobrada) o del núcleo se dice igual', async () => {
    const { accept } = setup({
      repoError: new ConflictException(
        'La opción B tiene abonos: no se puede rechazar.',
      ),
    });
    const res = await failure(accept());
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject(GENERIC);
    expect(JSON.stringify(res.body)).not.toContain('abonos');
  });

  it('el presupuesto cambió desde que se mostró: 409 PORTAL_QUOTE_CHANGED', async () => {
    const { accept } = setup();
    const res = await failure(accept({ contentHash: 'f'.repeat(64) }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({
      code: 'PORTAL_QUOTE_CHANGED',
      message:
        'El presupuesto ha cambiado. Recarga la página para ver la versión actual.',
    });
  });

  it('email de confirmación (variante de portal) al destinatario de la firma, sin importes', async () => {
    const { accept, sendBudgetAccepted } = setup();
    await accept();
    expect(sendBudgetAccepted).toHaveBeenCalledWith({
      to: 'maria@example.com',
      referenceId: PLAN,
      vars: {
        recipientFirstName: 'María',
        clinicName: 'Clínica Sonrisa Caracas',
        acceptedAtLabel: expect.stringContaining('2026') as string,
        viaPortal: true,
      },
    });
  });

  it('sin destinatario no se envía; si el outbox falla, la aceptación sigue valiendo', async () => {
    const noEmail = setup({
      outcome: {
        kind: 'ACCEPTED',
        acceptedAt: DB_NOW,
        confirmation: {
          to: null,
          greetingName: null,
          clinicName: 'Clínica',
          location: {
            id: 'loc-1',
            locale: 'es-VE',
            hourCycle: 'h12',
            timeZone: 'America/Caracas',
          },
        },
      },
    });
    await expect(noEmail.accept()).resolves.toBe(VIEW);
    expect(noEmail.sendBudgetAccepted).not.toHaveBeenCalled();

    const failing = setup({ emailFails: true });
    await expect(failing.accept()).resolves.toBe(VIEW);
  });
});
