import { BadRequestException } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type { PatientAging } from '../../domain/entities/receivables.entity';
import type { BalanceReminderPolicy } from '../../domain/balance-reminders';
import type { BalanceRemindersRepository } from '../../domain/ports/balance-reminders-repository.port';
import type { ReceivablesRepository } from '../../domain/ports/receivables-repository.port';
import {
  GetBalanceRemindersUseCase,
  UpdateBalanceReminderPolicyUseCase,
} from './balance-reminders.use-cases';
import type {
  AgingRowView,
  DebtorAgingRow,
  GetReceivablesAgingUseCase,
} from './get-receivables-aging.use-case';

// 2026-11-15 10:00 en Caracas (UTC−4).
const NOW = new Date('2026-11-15T14:00:00.000Z');
const CARACAS = 'America/Caracas';
const POLICY: BalanceReminderPolicy = {
  days: [7, 30, 60],
  maxNotices: 3,
  minGapDays: 7,
};

function aging(oldestAgeDays: number): PatientAging {
  return {
    currencies: [],
    oldestAgeDays,
    ageApproximate: false,
    paymentsWithoutRateCount: 0,
    rateProviderTimedOut: false,
  };
}

function row(patientId: string, age: number): DebtorAgingRow {
  return { patientId, locationId: 'loc-1', aging: aging(age) };
}

function setup(
  rows: DebtorAgingRow[],
  opts: {
    promised?: string[];
    optedOut?: string[];
    notices?: Record<string, Date[]>;
  } = {},
) {
  const minAges: (number | undefined)[] = [];
  const agingUseCase = {
    overdueDebtors: (filters: { minAgeDays?: number }) => {
      minAges.push(filters.minAgeDays);
      return Promise.resolve({
        rows,
        asOf: '2026-11-15',
        scope: { location: null },
        now: NOW,
        zoneOf: () => CARACAS,
      });
    },
    details: (page: DebtorAgingRow[]) =>
      Promise.resolve(
        page.map(
          (r) =>
            ({
              ...r.aging,
              patient: {
                id: r.patientId,
                fullName: r.patientId,
                phone: null,
                whatsApp: null,
              },
              locationId: r.locationId,
              lastPayment: null,
              nextInstallment: null,
              lastNote: null,
              promise: null,
            }) satisfies AgingRowView,
        ),
      ),
  } as unknown as GetReceivablesAgingUseCase;
  const reminders = {
    policy: () => Promise.resolve(POLICY),
    patientsOptedOut: () => Promise.resolve(new Set(opts.optedOut ?? [])),
    noticesOf: () =>
      Promise.resolve(new Map(Object.entries(opts.notices ?? {}))),
  } as unknown as BalanceRemindersRepository;
  const receivables = {
    patientsWithOpenPromise: () =>
      Promise.resolve(new Set(opts.promised ?? [])),
  } as unknown as ReceivablesRepository;
  return {
    useCase: new GetBalanceRemindersUseCase(
      agingUseCase,
      reminders,
      receivables,
    ),
    minAges,
  };
}

describe('GetBalanceRemindersUseCase (DX-146)', () => {
  it('pide a la cartera desde el primer tramo y deja solo a quien toca hoy', async () => {
    // c10: avisado a los 7 días (2026-11-12 en Caracas) → tramo 1 ya avisado.
    const { useCase, minAges } = setup(
      [row('a65', 65), row('b30', 30), row('c10', 10), row('d7', 7)],
      { notices: { c10: [new Date('2026-11-12T15:00:00.000Z')] } },
    );
    const page = await useCase.execute({});
    expect(minAges).toEqual([7]);
    expect(page.items.map((i) => i.patient.id)).toEqual(['a65', 'b30', 'd7']);
    expect(page.items[0].reminder).toEqual({
      stage: 3,
      stageDays: 60,
      noticesSent: 0,
      lastNoticeOn: null,
    });
  });

  it('el aviso de hoy cuenta con el día civil de la sede (Caracas), no el de UTC', async () => {
    // 2026-11-16T02:00Z es el 15/11 a las 22:00 en Caracas: avisado HOY.
    const { useCase } = setup([row('p', 7)], {
      notices: { p: [new Date('2026-11-16T02:00:00.000Z')] },
    });
    const page = await useCase.execute({});
    expect(page.items).toEqual([]);
  });

  it('fuera: compromiso de pago abierto y baja de los avisos, contados sin nombres', async () => {
    const { useCase } = setup(
      [row('ok', 30), row('promesa', 30), row('baja', 30), row('ambos', 30)],
      { promised: ['promesa', 'ambos'], optedOut: ['baja', 'ambos'] },
    );
    const page = await useCase.execute({});
    expect(page.items.map((i) => i.patient.id)).toEqual(['ok']);
    expect(page.excluded).toEqual({ openPromise: 2, optedOut: 1 });
    expect(page.total).toBe(1);
    expect(page.policy).toEqual(POLICY);
  });

  it('pagina sobre los que tocan, con el tope de 100', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => row(`p${i}`, 40));
    const { useCase } = setup(rows);
    const page = await useCase.execute({ page: 2, pageSize: 2 });
    expect(page.items.map((i) => i.patient.id)).toEqual(['p2', 'p3']);
    expect(page).toMatchObject({ total: 5, page: 2, pageSize: 2 });
    const big = await useCase.execute({ pageSize: 1000 });
    expect(big.pageSize).toBe(100);
  });
});

describe('UpdateBalanceReminderPolicyUseCase (DX-146)', () => {
  const ctx = { tenantId: 't1' } as AuditRequestContext;

  it('valida con mensaje en español antes de escribir', async () => {
    const setPolicy = jest.fn();
    const useCase = new UpdateBalanceReminderPolicyUseCase({
      setPolicy,
    } as unknown as BalanceRemindersRepository);
    await expect(
      useCase.execute({ days: [30, 7], maxNotices: 3, minGapDays: 7 }, ctx),
    ).rejects.toThrow(
      new BadRequestException(
        'Los tramos van de menor a mayor, sin repetir días.',
      ),
    );
    expect(setPolicy).not.toHaveBeenCalled();
  });

  it('devuelve la política guardada', async () => {
    const after = { days: [5, 15], maxNotices: 2, minGapDays: 5 };
    const setPolicy = jest.fn().mockResolvedValue({ before: POLICY, after });
    const useCase = new UpdateBalanceReminderPolicyUseCase({
      setPolicy,
    } as unknown as BalanceRemindersRepository);
    await expect(useCase.execute(after, ctx)).resolves.toEqual(after);
    expect(setPolicy).toHaveBeenCalledWith(after, ctx);
  });
});
