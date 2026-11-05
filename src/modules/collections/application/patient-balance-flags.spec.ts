import { ClinicRole } from '@prisma/client';
import { PatientBalanceFlags } from './patient-balance-flags';
import { PlanBalanceCalculator } from '../../payments/application/plan-balance-calculator';
import type { ConvertAmountUseCase } from '../../exchange/application/use-cases/convert-amount.use-case';
import type { CollectionsRepository } from '../domain/ports/collections-repository.port';
import type { PatientLedger } from '../../receivables/domain/entities/receivables.entity';

// 14:00 UTC = 10:00 en Caracas.
const NOW = new Date('2026-10-17T14:00:00.000Z');

/**
 * Paciente con un plan de USD 100 en dos cuotas ya vencidas, pagado con
 * Bs 3.600 en un abono anterior a DX-375 aún sin congelar (solo se podría
 * convertir con la tasa de su día, en vivo).
 */
function legacyLedger(): PatientLedger {
  return {
    patientId: 'pat-1',
    locationId: 'loc-1',
    plans: [
      {
        id: 'tp-1',
        status: 'ACCEPTED',
        currency: 'USD',
        createdAt: new Date('2026-07-01T12:00:00.000Z'),
        billable: 100,
        agingFrom: new Date('2026-07-01T12:00:00.000Z'),
        otherCurrency: {
          based: 0,
          pending: [
            {
              id: 'pay-legacy',
              currency: 'VES',
              amount: 3600,
              paidAt: new Date('2026-08-01T16:00:00.000Z'),
              locationId: 'loc-1',
              exchangeRateCurrency: null,
              frozenRate: null,
            },
          ],
        },
      },
    ],
    paid: [{ treatmentPlanId: 'tp-1', currency: 'VES', amount: 3600 }],
    paymentPlans: [
      {
        id: 'pp-1',
        treatmentPlanId: 'tp-1',
        currency: 'USD',
        status: 'ACTIVE',
        downPayment: 0,
        startDate: new Date('2026-08-03T00:00:00.000Z'),
        installments: [
          {
            sequence: 1,
            dueDate: new Date('2026-08-03T00:00:00.000Z'),
            amount: 50,
          },
          {
            sequence: 2,
            dueDate: new Date('2026-09-03T00:00:00.000Z'),
            amount: 50,
          },
        ],
      },
    ],
  };
}

const repo = {
  ledgersOf: () => Promise.resolve([legacyLedger()]),
  locationTimeZones: () => Promise.resolve(() => 'America/Caracas'),
} as unknown as CollectionsRepository;

describe('PatientBalanceFlags (DX-472-bis, revisión M1): la agenda no depende del proveedor de tasas', () => {
  it('con el proveedor colgado responde al instante: no convierte en vivo, nada vencido y la marca dice «incompleto»', async () => {
    const hanging = jest.fn(() => new Promise<never>(() => undefined));
    const convert = {
      memoized: () => ({ execute: hanging, quote: hanging }),
    } as unknown as ConvertAmountUseCase;
    const flags = new PatientBalanceFlags(
      repo,
      () => NOW,
      new PlanBalanceCalculator(convert),
    );

    const started = Date.now();
    const chip = await flags.forPatient('pat-1', ClinicRole.RECEPTION);

    expect(Date.now() - started).toBeLessThan(500);
    expect(hanging).not.toHaveBeenCalled();
    expect(chip).toEqual({
      hasOverdue: false,
      overdueDays: null,
      incomplete: true,
    });
  });

  it('si la conversión falla por cualquier otra cosa (p. ej. leer las tasas), la marca sale sin convertir y no lanza', async () => {
    const calculator = {
      computeMany: jest.fn(() =>
        Promise.reject(new Error('fallo al leer las tasas')),
      ),
    } as unknown as PlanBalanceCalculator;
    const flags = new PatientBalanceFlags(repo, () => NOW, calculator);

    const chip = await flags.forPatient('pat-1', ClinicRole.RECEPTION);

    // Como antes de DX-472-bis: lo abonado en bolívares no cuenta en USD.
    expect(chip).toMatchObject({
      hasOverdue: true,
      amounts: [{ currency: 'USD', amount: 100 }],
    });
  });

  it('pide el saldo sin red', async () => {
    const computeMany = jest.fn(() => Promise.resolve(new Map()));
    const calculator = { computeMany } as unknown as PlanBalanceCalculator;
    const flags = new PatientBalanceFlags(repo, () => NOW, calculator);

    await flags.forPatients(['pat-1'], ClinicRole.ADMIN);

    expect(computeMany).toHaveBeenCalledWith(expect.any(Array), {
      offline: true,
    });
  });
});

describe('PatientBalanceFlags.viewsForPatients (DX-224): saldo pendiente por moneda', () => {
  const calculator = {
    computeMany: jest.fn(() => Promise.resolve(new Map())),
  } as unknown as PlanBalanceCalculator;

  it('ADMIN y RECEPTION ven el pendiente; DENTIST y ASSISTANT solo la marca', async () => {
    const flags = new PatientBalanceFlags(repo, () => NOW, calculator);
    for (const role of [ClinicRole.ADMIN, ClinicRole.RECEPTION]) {
      const view = (await flags.viewsForPatients(['pat-1'], role)).get('pat-1');
      expect(view?.pending).toEqual([{ currency: 'USD', amount: 100 }]);
      expect(view?.overdue.hasOverdue).toBe(true);
    }
    for (const role of [ClinicRole.DENTIST, ClinicRole.ASSISTANT]) {
      const view = (await flags.viewsForPatients(['pat-1'], role)).get('pat-1');
      expect(view?.pending).toEqual([]);
      expect(view?.overdue).toMatchObject({ hasOverdue: true });
      expect(view?.overdue.amounts).toBeUndefined();
    }
  });

  it('un paciente sin deuda (o sin libro) trae la vista vacía', async () => {
    const empty = {
      ledgersOf: () => Promise.resolve([]),
      locationTimeZones: () => Promise.resolve(() => 'America/Caracas'),
    } as unknown as CollectionsRepository;
    const flags = new PatientBalanceFlags(empty, () => NOW, calculator);
    const view = (
      await flags.viewsForPatients(['pat-9'], ClinicRole.ADMIN)
    ).get('pat-9');
    expect(view).toEqual({
      overdue: { hasOverdue: false, overdueDays: null },
      pending: [],
    });
  });
});
