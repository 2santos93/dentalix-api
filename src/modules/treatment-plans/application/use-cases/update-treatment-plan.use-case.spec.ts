import { testDiscountPolicy } from './__fixtures__/discount-fixtures';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ClinicRole,
  TreatmentPlanRejectionReason,
  TreatmentPlanStatus,
} from '@prisma/client';
import {
  PLAN_CHANGED_RETRY_MESSAGE,
  UpdateTreatmentPlanUseCase,
} from './update-treatment-plan.use-case';
import type {
  QuoteExpiryRegional,
  QuoteExpiryRegionalReader,
} from '../../domain/ports/quote-expiry-regional.port';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';
import { UNKNOWN_CURRENCY_MESSAGE } from '../../../../shared/money/currency-messages';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;
const DENTIST = { role: ClinicRole.DENTIST };

// Fake whitelist: allows the codes actually exercised by this suite. `has`
// is case-sensitive here on purpose, to catch a regression where the use
// case forgets to `.toUpperCase()` BEFORE calling it.
function makeWhitelist(allowed: string[] = ['USD', 'VES']): CurrencyWhitelist {
  return {
    has: (code: string): Promise<boolean> =>
      Promise.resolve(allowed.includes(code)),
  };
}

function setup(whitelist: CurrencyWhitelist = makeWhitelist()) {
  const repo = new InMemoryTreatmentPlanRepository();
  const uc = new UpdateTreatmentPlanUseCase(
    repo,
    whitelist,
    () => NOW,
    testDiscountPolicy(),
  );
  return { repo, uc };
}

describe('UpdateTreatmentPlanUseCase', () => {
  it('throws NotFoundException when the plan does not exist (or belongs to another tenant)', async () => {
    const { uc } = setup();
    await expect(
      uc.execute('missing-id', { status: ACCEPTED }, DENTIST),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it.each([
    [DRAFT, ACCEPTED],
    [DRAFT, CANCELLED],
    [PRESENTED, ACCEPTED],
    [PRESENTED, CANCELLED],
    [ACCEPTED, COMPLETED],
    [ACCEPTED, CANCELLED],
    [REJECTED, CANCELLED],
  ])('permite %s → %s', async (from, to) => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: from });
    const result = await uc.execute(plan.id, { status: to }, DENTIST);
    expect(result.status).toBe(to);
  });

  it.each([
    [COMPLETED, ACCEPTED],
    [COMPLETED, CANCELLED],
    [COMPLETED, DRAFT],
    [CANCELLED, ACCEPTED],
    [CANCELLED, DRAFT],
    [REJECTED, ACCEPTED],
    [ACCEPTED, DRAFT],
    [DRAFT, COMPLETED],
  ])(
    'una transición inválida %s → %s es 409 y no escribe',
    async (from, to) => {
      const { repo, uc } = setup();
      const plan = repo.seedPlan({ status: from, notes: 'antes' });
      await expect(
        uc.execute(plan.id, { status: to, notes: 'después' }, DENTIST),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(repo.stored(plan.id)).toMatchObject({
        status: from,
        notes: 'antes',
      });
    },
  );

  it('el mismo estado no es una transición: se guardan las notas sin 409', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: COMPLETED });
    const result = await uc.execute(
      plan.id,
      { status: COMPLETED, notes: 'Cierre revisado' },
      DENTIST,
    );
    expect(result).toMatchObject({
      status: COMPLETED,
      notes: 'Cierre revisado',
    });
  });

  it.each([PRESENTED, REJECTED])(
    'el PATCH no presenta ni rechaza (%s): eso tiene su propia acción (400)',
    async (status) => {
      const { repo, uc } = setup();
      const plan = repo.seedPlan({ status: DRAFT });
      await expect(uc.execute(plan.id, { status }, DENTIST)).rejects.toThrow(
        'Para presentar o rechazar un plan usa sus acciones «Presentar» y «Rechazar».',
      );
    },
  );

  it('la asistente no acepta un plan en nombre del odontólogo (403)', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: DRAFT });
    await expect(
      uc.execute(plan.id, { status: ACCEPTED }, { role: ClinicRole.ASSISTANT }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(repo.stored(plan.id).status).toBe(DRAFT);
  });

  it('la asistente sí cancela o completa', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: ACCEPTED });
    const result = await uc.execute(
      plan.id,
      { status: COMPLETED },
      { role: ClinicRole.ASSISTANT },
    );
    expect(result.status).toBe(COMPLETED);
  });

  it('aceptar una opción rechaza a sus hermanas abiertas con «otra opción aceptada»', async () => {
    const { repo, uc } = setup();
    const a = repo.seedPlan({ id: 'a', status: PRESENTED, optionGroupId: 'a' });
    repo.seedPlan({ id: 'b', status: PRESENTED, optionGroupId: 'a' });
    repo.seedPlan({ id: 'c', status: DRAFT, optionGroupId: 'a' });
    repo.seedPlan({ id: 'd', status: CANCELLED, optionGroupId: 'a' });
    repo.seedPlan({ id: 'loose', status: DRAFT });

    await uc.execute(a.id, { status: ACCEPTED }, DENTIST);

    for (const id of ['b', 'c']) {
      expect(repo.stored(id)).toMatchObject({
        status: REJECTED,
        rejectedAt: NOW,
        rejectionReason: TreatmentPlanRejectionReason.OTHER_OPTION_ACCEPTED,
      });
    }
    expect(repo.stored('d').status).toBe(CANCELLED);
    expect(repo.stored('loose').status).toBe(DRAFT);
  });

  it('aceptar con una hermana ya cobrada (abonos) es 409 claro y no cambia nada', async () => {
    const { repo, uc } = setup();
    const a = repo.seedPlan({ id: 'a', status: PRESENTED, optionGroupId: 'a' });
    repo.seedPlan({
      id: 'b',
      status: PRESENTED,
      optionGroupId: 'a',
      optionLabel: 'Opción B',
    });
    repo.livePaymentPlanIds.add('b');
    await expect(
      uc.execute(a.id, { status: ACCEPTED }, DENTIST),
    ).rejects.toThrow(
      new ConflictException(
        'La opción «Opción B» tiene abonos o procedimientos realizados: no se puede rechazar al aceptar esta. Revísala antes de aceptar.',
      ),
    );
    expect(repo.stored('a').status).toBe(PRESENTED);
    expect(repo.stored('b').status).toBe(PRESENTED);
  });

  it('la comprobación de rol solo aplica si de verdad cambia a ACCEPTED', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ status: ACCEPTED });
    const result = await uc.execute(
      plan.id,
      { status: ACCEPTED, notes: 'Revisado por la asistente' },
      { role: ClinicRole.ASSISTANT },
    );
    expect(result.notes).toBe('Revisado por la asistente');
  });

  it('cancelar o completar no toca a las hermanas', async () => {
    const { repo, uc } = setup();
    const a = repo.seedPlan({ id: 'a', status: DRAFT, optionGroupId: 'a' });
    repo.seedPlan({ id: 'b', status: PRESENTED, optionGroupId: 'a' });
    await uc.execute(a.id, { status: CANCELLED }, DENTIST);
    expect(repo.stored('b').status).toBe(PRESENTED);
  });

  it('cambia la etiqueta de la opción (recortada; vacía = sin etiqueta)', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan({ optionGroupId: 'x', optionLabel: 'Opción A' });
    const renamed = await uc.execute(
      plan.id,
      { optionLabel: '  Opción A: implante ' },
      DENTIST,
    );
    expect(renamed.optionLabel).toBe('Opción A: implante');
    const cleared = await uc.execute(plan.id, { optionLabel: '  ' }, DENTIST);
    expect(cleared.optionLabel).toBeNull();
  });

  it('validates and uppercases currency only when provided, forwarding it to the repo', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan();
    const result = await uc.execute(plan.id, { currency: 'ves' }, DENTIST);
    expect(result.currency).toBe('VES');
  });

  it('rejects an unknown currency with BadRequestException, without writing', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan();
    await expect(
      uc.execute(plan.id, { currency: 'XXX' }, DENTIST),
    ).rejects.toThrow(new BadRequestException(UNKNOWN_CURRENCY_MESSAGE));
    expect(repo.stored(plan.id).currency).toBe('USD');
  });

  it('leaves currency untouched (no whitelist call needed) when omitted', async () => {
    const { repo, uc } = setup(makeWhitelist([]));
    const plan = repo.seedPlan({ currency: 'VES' });
    const result = await uc.execute(
      plan.id,
      { notes: 'sin cambio de moneda' },
      DENTIST,
    );
    expect(result.currency).toBe('VES');
  });

  describe('plan con un cargo por inasistencia vigente (SEC-050)', () => {
    const FEE_PLAN_LOCKED =
      'Este plan lleva un cargo por inasistencia o cancelación tardía vigente: no se cancela ni cambia de moneda. Anula antes el cargo desde la cita (con motivo).';
    function feePlan() {
      const ctx = setup();
      const plan = ctx.repo.seedPlan({ status: ACCEPTED, currency: 'VES' });
      ctx.repo.seedItem({
        planId: plan.id,
        price: 50000,
        cancellationFeeAppointmentId: 'appt-1',
      });
      return { ...ctx, plan };
    }

    it('cancelarlo: 409 en español y sigue aceptado', async () => {
      const { repo, uc, plan } = feePlan();
      await expect(
        uc.execute(plan.id, { status: CANCELLED }, DENTIST),
      ).rejects.toThrow(new ConflictException(FEE_PLAN_LOCKED));
      expect(repo.stored(plan.id).status).toBe(ACCEPTED);
    });

    it('cambiarle la moneda: 409', async () => {
      const { uc, plan } = feePlan();
      await expect(
        uc.execute(plan.id, { currency: 'USD' }, DENTIST),
      ).rejects.toThrow(new ConflictException(FEE_PLAN_LOCKED));
    });

    it('las notas, o completarlo, sí', async () => {
      const { uc, plan } = feePlan();
      await expect(
        uc.execute(plan.id, { notes: 'Cargos', status: COMPLETED }, DENTIST),
      ).resolves.toMatchObject({ status: COMPLETED, notes: 'Cargos' });
    });
  });

  describe('plan con asientos de saldo a favor (DX-438)', () => {
    const CREDIT_LOCKED =
      'El plan tiene saldo a favor traspasado o devuelto: su moneda ya no cambia, porque ese saldo está en la moneda actual del plan.';
    function creditPlan(status: TreatmentPlanStatus) {
      const ctx = setup();
      // Recibió un traspaso: tiene asientos, pero ningún abono.
      const plan = ctx.repo.seedPlan({ status, currency: 'VES' });
      ctx.repo.creditEntryPlanIds.add(plan.id);
      return { ...ctx, plan };
    }

    it.each([DRAFT, PRESENTED])(
      'en %s sin abonos, cambiar la moneda es 409 con código propio y no escribe',
      async (status) => {
        const { repo, uc, plan } = creditPlan(status);
        const error: unknown = await uc
          .execute(plan.id, { currency: 'usd', notes: 'después' }, DENTIST)
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(ConflictException);
        expect((error as ConflictException).getResponse()).toEqual({
          statusCode: 409,
          error: 'Conflict',
          code: 'PLAN_CURRENCY_LOCKED_BY_CREDIT',
          message: CREDIT_LOCKED,
        });
        expect(repo.stored(plan.id).currency).toBe('VES');
        expect(repo.stored(plan.id).notes).not.toBe('después');
      },
    );

    it('la misma moneda, las notas o cancelarlo sí pasan', async () => {
      const { uc, plan } = creditPlan(DRAFT);
      await expect(
        uc.execute(plan.id, { currency: 'ves', notes: 'Notas' }, DENTIST),
      ).resolves.toMatchObject({ currency: 'VES', notes: 'Notas' });
      await expect(
        uc.execute(plan.id, { status: CANCELLED }, DENTIST),
      ).resolves.toMatchObject({ status: CANCELLED, currency: 'VES' });
    });

    it('con asientos y además abonos vivos, el 409 es el del saldo a favor (anular los abonos no lo desbloquearía)', async () => {
      const { repo, uc, plan } = creditPlan(PRESENTED);
      repo.livePaymentPlanIds.add(plan.id);
      const error: unknown = await uc
        .execute(plan.id, { currency: 'USD' }, DENTIST)
        .catch((e: unknown) => e);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'PLAN_CURRENCY_LOCKED_BY_CREDIT',
        message: CREDIT_LOCKED,
      });
      expect(repo.stored(plan.id).currency).toBe('VES');
    });

    it('sin asientos ni abonos la moneda de un borrador sí cambia', async () => {
      const { repo, uc } = setup();
      const plan = repo.seedPlan({ status: DRAFT, currency: 'VES' });
      await expect(
        uc.execute(plan.id, { currency: 'USD' }, DENTIST),
      ).resolves.toMatchObject({ currency: 'USD' });
    });
  });
});

describe('DX-379 (C): PATCH «Aceptado» de un presupuesto vencido', () => {
  // 16/10/2026 11:00 en Caracas.
  const regional = (
    overrides: Partial<QuoteExpiryRegional> = {},
  ): QuoteExpiryRegionalReader & { calls: number } => {
    const reader = {
      calls: 0,
      forPlan: () => {
        reader.calls += 1;
        return Promise.resolve({
          presentedLocationId: 'loc-1',
          locationId: 'loc-1',
          timeZone: 'America/Caracas',
          locale: 'es-VE',
          hourCycle: 'h12',
          ...overrides,
        });
      },
    };
    return reader;
  };

  function setupWith(reader: QuoteExpiryRegionalReader) {
    const repo = new InMemoryTreatmentPlanRepository();
    const uc = new UpdateTreatmentPlanUseCase(
      repo,
      makeWhitelist(),
      () => NOW,
      testDiscountPolicy(),
      reader,
    );
    return { repo, uc };
  }

  const presentedPlan = (
    repo: InMemoryTreatmentPlanRepository,
    validUntil: string,
  ) =>
    repo.seedPlan({
      status: PRESENTED,
      presentedLocationId: 'loc-1',
      quoteIssuedOn: '2026-09-01',
      quoteValidUntil: validUntil,
    });

  it('vencido → 409 QUOTE_EXPIRED en español y el plan no cambia', async () => {
    const { repo, uc } = setupWith(regional());
    const plan = presentedPlan(repo, '2026-10-01');
    let error: unknown;
    try {
      await uc.execute(plan.id, { status: ACCEPTED }, DENTIST);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: 'QUOTE_EXPIRED',
      message:
        'El presupuesto venció el 01/10/2026: acéptalo con firma para elegir cómo.',
      quoteValidUntil: '2026-10-01',
    });
    expect((await repo.findPlanById(plan.id))?.status).toBe(PRESENTED);
  });

  it('no vencido (el último día vale) → acepta', async () => {
    const { repo, uc } = setupWith(regional());
    const plan = presentedPlan(repo, '2026-10-16');
    const result = await uc.execute(plan.id, { status: ACCEPTED }, DENTIST);
    expect(result.status).toBe(ACCEPTED);
  });

  it('sin validez guardada (plan anterior a DX-379) → acepta como siempre', async () => {
    const { repo, uc } = setupWith(regional());
    const plan = repo.seedPlan({ status: PRESENTED });
    const result = await uc.execute(plan.id, { status: ACCEPTED }, DENTIST);
    expect(result.status).toBe(ACCEPTED);
  });

  it('solo mira la sede al ACEPTAR: cancelar un vencido no la lee', async () => {
    const reader = regional();
    const { repo, uc } = setupWith(reader);
    const plan = presentedPlan(repo, '2026-10-01');
    const result = await uc.execute(plan.id, { status: CANCELLED }, DENTIST);
    expect(result.status).toBe(CANCELLED);
    expect(reader.calls).toBe(0);
  });

  it('sede sin zona válida → 409 LOCATION_TIMEZONE_REQUIRED (nunca otra zona)', async () => {
    const { repo, uc } = setupWith(regional({ timeZone: null }));
    const plan = presentedPlan(repo, '2026-10-20');
    await expect(
      uc.execute(plan.id, { status: ACCEPTED }, DENTIST),
    ).rejects.toMatchObject({
      response: { code: 'LOCATION_TIMEZONE_REQUIRED' },
    });
  });

  it('presentado en otra sede entre la lectura y el bloqueo → 409 «vuelve a intentarlo»', async () => {
    const { repo, uc } = setupWith(regional({ presentedLocationId: null }));
    const plan = presentedPlan(repo, '2026-10-20');
    await expect(
      uc.execute(plan.id, { status: ACCEPTED }, DENTIST),
    ).rejects.toThrow(PLAN_CHANGED_RETRY_MESSAGE);
  });
});
