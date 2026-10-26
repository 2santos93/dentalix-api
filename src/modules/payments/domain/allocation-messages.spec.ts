import { TreatmentPlanStatus } from '@prisma/client';
import {
  ALLOCATION_MODE_MISMATCH,
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
});
