import { ClinicRole } from '@prisma/client';
import {
  canMoveCredit,
  formatRefundNumber,
  normalizeReason,
  parseIdempotencyKey,
  planCreditCents,
  receptionCapMessage,
  refundFingerprint,
  refundSeriesOf,
  transferFingerprint,
} from './patient-credit';

describe('saldo a favor (DX-253)', () => {
  describe('planCreditCents', () => {
    it('plan cancelado: todo lo abonado queda a favor', () => {
      expect(
        planCreditCents({
          billableCents: 0,
          paidCents: 30_000_000,
          entriesCents: 0,
        }),
      ).toBe(30_000_000);
    });

    it('tras traspasar 200.000 quedan 100.000 a favor', () => {
      expect(
        planCreditCents({
          billableCents: 0,
          paidCents: 30_000_000,
          entriesCents: -20_000_000,
        }),
      ).toBe(10_000_000);
    });

    it('plan vivo pagado de más: solo el exceso, y nunca negativo', () => {
      expect(
        planCreditCents({
          billableCents: 500,
          paidCents: 800,
          entriesCents: 0,
        }),
      ).toBe(300);
      expect(
        planCreditCents({
          billableCents: 900,
          paidCents: 800,
          entriesCents: 0,
        }),
      ).toBe(0);
    });

    it('un traspaso recibido y una devolución cuentan con su signo', () => {
      expect(
        planCreditCents({
          billableCents: 1_000,
          paidCents: 0,
          entriesCents: 1_500 - 200,
        }),
      ).toBe(300);
    });
  });

  describe('canMoveCredit (tope por rol, patrón DX-204)', () => {
    it('ADMIN siempre', () => {
      expect(canMoveCredit(ClinicRole.ADMIN, 999_999_999, 0)).toBe(true);
    });

    it('RECEPTION hasta el tope inclusive; con 0 (por defecto) nada', () => {
      expect(canMoveCredit(ClinicRole.RECEPTION, 1, 0)).toBe(false);
      expect(canMoveCredit(ClinicRole.RECEPTION, 5_000, 5_000)).toBe(true);
      expect(canMoveCredit(ClinicRole.RECEPTION, 5_001, 5_000)).toBe(false);
    });

    it('DENTIST y ASSISTANT nunca', () => {
      expect(canMoveCredit(ClinicRole.DENTIST, 1, 1_000)).toBe(false);
      expect(canMoveCredit(ClinicRole.ASSISTANT, 1, 1_000)).toBe(false);
    });

    it('el 403 explica el tope en español', () => {
      expect(receptionCapMessage(0)).toMatch(/administración/);
      expect(receptionCapMessage(50_000)).toContain('500.00');
    });
  });

  it('el motivo se recorta y exige 3–500 caracteres', () => {
    expect(normalizeReason('  Paciente se muda  ')).toBe('Paciente se muda');
    expect(normalizeReason('no')).toBeNull();
    expect(normalizeReason('x'.repeat(501))).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
  });

  it('serie propia DEV-<serie de la sede> y número de 6 cifras', () => {
    expect(refundSeriesOf('BOG')).toBe('DEV-BOG');
    expect(formatRefundNumber('DEV-BOG', 7)).toBe('DEV-BOG-000007');
    expect(() => refundSeriesOf('bad prefix')).toThrow(RangeError);
    expect(() => formatRefundNumber('DEV-BOG', 0)).toThrow(RangeError);
  });

  it('Idempotency-Key: UUID o 400', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
    expect(parseIdempotencyKey('  ')).toBeUndefined();
    expect(parseIdempotencyKey('nope')).toBeNull();
    expect(parseIdempotencyKey('3F2504E0-4F89-11D3-9A0C-0305E82C3301')).toBe(
      '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    );
  });

  it('huellas: el mismo cuerpo da la misma; otro importe, otra', () => {
    const base = {
      planId: 'A',
      amountCents: 100,
      currency: 'cop',
      method: 'CASH' as const,
      reason: 'Motivo',
      paymentIds: ['b', 'a', 'a'],
    };
    expect(refundFingerprint(base)).toBe(
      refundFingerprint({ ...base, currency: 'COP', paymentIds: ['a', 'b'] }),
    );
    expect(refundFingerprint(base)).not.toBe(
      refundFingerprint({ ...base, amountCents: 101 }),
    );
    const transfer = {
      sourcePlanId: 'A',
      targetPlanId: 'B',
      amountCents: 1,
      currency: 'COP',
      reason: null,
    };
    expect(transferFingerprint(transfer)).not.toBe(
      transferFingerprint({ ...transfer, targetPlanId: 'C' }),
    );
  });
});
