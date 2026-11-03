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
} from './allocation-messages';
import { regionalFormat } from '../../../shared/format/regional-format';

const enUS = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
const deDE = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
const esVE = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });

describe('allocation messages (spec §5.3)', () => {
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
    expect(allocationOverItem(5000, 'USD', enUS)).toBe(
      'Un ítem admite como máximo USD\u00a050.00: es lo que le queda por cubrir.',
    );
    expect(allocationOverItem(123450, 'USD', enUS)).toContain(
      'USD\u00a01,234.50',
    );
    expect(allocationOverItem(123450, 'EUR', deDE)).toContain(
      '1.234,50\u00a0EUR',
    );
    expect(allocationOverItem(123450, 'VES', esVE)).toContain(
      'VES\u00a01.234,50',
    );
  });

  it('over payment', () => {
    expect(allocationOverPayment(12100, 12000, 'USD', enUS)).toBe(
      'La suma imputada (USD\u00a0121.00) supera el abono convertido a la moneda del plan (USD\u00a0120.00).',
    );
    expect(allocationOverPayment(123450, 120000, 'EUR', deDE)).toBe(
      'La suma imputada (1.234,50\u00a0EUR) supera el abono convertido a la moneda del plan (1.200,00\u00a0EUR).',
    );
    expect(allocationOverPayment(123450, 120000, 'VES', esVE)).toContain(
      'VES\u00a01.234,50',
    );
  });

  it('mode mismatch', () => {
    expect(ALLOCATION_MODE_MISMATCH).toBe(
      'Con el reparto automático no se envían importes; con el manual, sí.',
    );
  });

  it('maps each line violation to its §5.3 message', () => {
    expect(
      allocationViolationMessage({ code: 'DUPLICATE' }, 'EUR', 9000, deDE),
    ).toBe(ALLOCATION_DUPLICATE_ITEM);
    expect(
      allocationViolationMessage({ code: 'TOO_MANY' }, 'EUR', 9000, deDE),
    ).toBe(ALLOCATION_TOO_MANY_LINES);
    expect(
      allocationViolationMessage({ code: 'NOT_IN_PLAN' }, 'EUR', 9000, deDE),
    ).toBe(ALLOCATION_ITEM_NOT_IN_PLAN);
    expect(
      allocationViolationMessage({ code: 'PROPOSED' }, 'EUR', 9000, deDE),
    ).toBe(ALLOCATION_ITEM_PROPOSED);
    expect(
      allocationViolationMessage(
        { code: 'OVER_ITEM', freeCents: 2500 },
        'EUR',
        9000,
        deDE,
      ),
    ).toBe(
      'Un ítem admite como máximo 25,00\u00a0EUR: es lo que le queda por cubrir.',
    );
    expect(
      allocationViolationMessage(
        { code: 'OVER_PAYMENT', sumCents: 9500 },
        'EUR',
        9000,
        deDE,
      ),
    ).toBe(
      'La suma imputada (95,00\u00a0EUR) supera el abono convertido a la moneda del plan (90,00\u00a0EUR).',
    );
  });
});
