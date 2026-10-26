import { TreatmentPlanStatus } from '@prisma/client';
import {
  ALLOCATION_DUPLICATE_ITEM,
  ALLOCATION_ITEM_NOT_IN_PLAN,
  ALLOCATION_ITEM_PROPOSED,
  ALLOCATION_MODE_MISMATCH,
  ALLOCATION_TOO_MANY_LINES,
  allocationViolationMessage,
  allocationNoRate,
  allocationOverItem,
  allocationOverPayment,
  allocationPlanNotBillable,
  formatCents,
} from './allocation-messages';

describe('allocation messages (spec §5.3)', () => {
  it('formats cents with 2 decimals, a dot and no thousands separator', () => {
    expect(formatCents(123450)).toBe('1234.50');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(0)).toBe('0.00');
  });

  it('plan not billable names the status', () => {
    expect(allocationPlanNotBillable(TreatmentPlanStatus.REJECTED)).toBe(
      'El plan está «Rechazado»: sus abonos no se imputan a ítems.',
    );
    expect(allocationPlanNotBillable(TreatmentPlanStatus.CANCELLED)).toBe(
      'El plan está «Cancelado»: sus abonos no se imputan a ítems.',
    );
  });

  it('no rate', () => {
    expect(allocationNoRate('EUR', 'USD', '2026-10-20')).toBe(
      'No hay tasa de cambio de EUR a USD para el 2026-10-20: este abono no se puede imputar todavía.',
    );
  });

  it('over item', () => {
    expect(allocationOverItem(5000, 'USD')).toBe(
      'Un ítem admite como máximo 50.00 USD: el resto ya lo cubren otros abonos.',
    );
  });

  it('over payment', () => {
    expect(allocationOverPayment(12100, 12000, 'USD')).toBe(
      'La suma imputada (121.00 USD) supera el abono convertido a la moneda del plan (120.00 USD).',
    );
  });

  it('mode mismatch', () => {
    expect(ALLOCATION_MODE_MISMATCH).toBe(
      'Con el reparto automático no se envían importes; con el manual, sí.',
    );
  });

  it('maps each line violation to its §5.3 message', () => {
    expect(allocationViolationMessage({ code: 'DUPLICATE' }, 'EUR', 9000)).toBe(
      ALLOCATION_DUPLICATE_ITEM,
    );
    expect(allocationViolationMessage({ code: 'TOO_MANY' }, 'EUR', 9000)).toBe(
      ALLOCATION_TOO_MANY_LINES,
    );
    expect(
      allocationViolationMessage({ code: 'NOT_IN_PLAN' }, 'EUR', 9000),
    ).toBe(ALLOCATION_ITEM_NOT_IN_PLAN);
    expect(allocationViolationMessage({ code: 'PROPOSED' }, 'EUR', 9000)).toBe(
      ALLOCATION_ITEM_PROPOSED,
    );
    expect(
      allocationViolationMessage(
        { code: 'OVER_ITEM', freeCents: 2500 },
        'EUR',
        9000,
      ),
    ).toBe(
      'Un ítem admite como máximo 25.00 EUR: el resto ya lo cubren otros abonos.',
    );
    expect(
      allocationViolationMessage(
        { code: 'OVER_PAYMENT', sumCents: 9500 },
        'EUR',
        9000,
      ),
    ).toBe(
      'La suma imputada (95.00 EUR) supera el abono convertido a la moneda del plan (90.00 EUR).',
    );
  });
});
