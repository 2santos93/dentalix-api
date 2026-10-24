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
import { UpdateTreatmentPlanUseCase } from './update-treatment-plan.use-case';
import { InMemoryTreatmentPlanRepository } from './__fixtures__/in-memory-treatment-plan.repository';
import { CurrencyWhitelist } from '../../domain/ports/currency-whitelist.port';

const NOW = new Date('2026-10-16T15:00:00.000Z');
const { DRAFT, PRESENTED, ACCEPTED, REJECTED, COMPLETED, CANCELLED } =
  TreatmentPlanStatus;
const DENTIST = { role: ClinicRole.DENTIST };

// Fake whitelist: allows the codes actually exercised by this suite. `has`
// is case-sensitive here on purpose, to catch a regression where the use
// case forgets to `.toUpperCase()` BEFORE calling it.
function makeWhitelist(allowed: string[] = ['USD', 'COP']): CurrencyWhitelist {
  return {
    has: (code: string): Promise<boolean> =>
      Promise.resolve(allowed.includes(code)),
  };
}

function setup(whitelist: CurrencyWhitelist = makeWhitelist()) {
  const repo = new InMemoryTreatmentPlanRepository();
  const uc = new UpdateTreatmentPlanUseCase(repo, whitelist, () => NOW);
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
    const result = await uc.execute(plan.id, { currency: 'cop' }, DENTIST);
    expect(result.currency).toBe('COP');
  });

  it('rejects an unknown currency with BadRequestException, without writing', async () => {
    const { repo, uc } = setup();
    const plan = repo.seedPlan();
    await expect(
      uc.execute(plan.id, { currency: 'XXX' }, DENTIST),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(repo.stored(plan.id).currency).toBe('USD');
  });

  it('leaves currency untouched (no whitelist call needed) when omitted', async () => {
    const { repo, uc } = setup(makeWhitelist([]));
    const plan = repo.seedPlan({ currency: 'COP' });
    const result = await uc.execute(
      plan.id,
      { notes: 'sin cambio de moneda' },
      DENTIST,
    );
    expect(result.currency).toBe('COP');
  });

  describe('plan con un cargo por inasistencia vigente (SEC-050)', () => {
    const FEE_PLAN_LOCKED =
      'Este plan lleva un cargo por inasistencia o cancelación tardía vigente: no se cancela ni cambia de moneda. Anula antes el cargo desde la cita (con motivo).';
    function feePlan() {
      const ctx = setup();
      const plan = ctx.repo.seedPlan({ status: ACCEPTED, currency: 'COP' });
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
});
