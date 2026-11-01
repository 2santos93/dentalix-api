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
  voidRefundReferenceMessage,
  voidUncoversMovedCredit,
} from './patient-credit';

describe('saldo a favor (DX-253)', () => {
  describe('voidUncoversMovedCredit (anular un abono)', () => {
    // Plan cancelado con 300.000 abonados en dos abonos (200.000 + 100.000).
    const cancelled = { billableCents: 0, paidCents: 30_000_000 };

    it('sin salidas de saldo a favor, anular es lo de siempre', () => {
      expect(
        voidUncoversMovedCredit({
          ...cancelled,
          entriesCents: 0,
          outflowCents: 0,
          voidedCents: 20_000_000,
        }),
      ).toBe(false);
    });

    it('tras traspasar 200.000, anular 100.000 deja justo 0: se permite', () => {
      expect(
        voidUncoversMovedCredit({
          ...cancelled,
          entriesCents: -20_000_000,
          outflowCents: 20_000_000,
          voidedCents: 10_000_000,
        }),
      ).toBe(false);
    });

    it('tras traspasar 200.000, anular 200.000 lo deja al descubierto: 409', () => {
      expect(
        voidUncoversMovedCredit({
          ...cancelled,
          entriesCents: -20_000_000,
          outflowCents: 20_000_000,
          voidedCents: 20_000_000,
        }),
      ).toBe(true);
    });

    it('plan vivo: cuenta el facturable (devuelto el exceso, anular deja deuda)', () => {
      expect(
        voidUncoversMovedCredit({
          billableCents: 50_000,
          paidCents: 80_000,
          entriesCents: -30_000,
          outflowCents: 30_000,
          voidedCents: 1,
        }),
      ).toBe(true);
    });

    it('lo recibido por traspaso cubre: anular un abono del destino sin salidas', () => {
      expect(
        voidUncoversMovedCredit({
          billableCents: 40_000_000,
          paidCents: 1_000_000,
          entriesCents: 20_000_000,
          outflowCents: 0,
          voidedCents: 1_000_000,
        }),
      ).toBe(false);
    });

    it('cobro dividido: suma todas las líneas anuladas', () => {
      const base = {
        billableCents: 0,
        paidCents: 15_000_000,
        entriesCents: -10_000_000,
        outflowCents: 10_000_000,
      };
      expect(voidUncoversMovedCredit({ ...base, voidedCents: 5_000_000 })).toBe(
        false,
      );
      expect(
        voidUncoversMovedCredit({ ...base, voidedCents: 15_000_000 }),
      ).toBe(true);
    });

    it('el 409 de un abono de referencia nombra la devolución', () => {
      expect(voidRefundReferenceMessage('DEV-BOG-000007')).toMatch(
        /^No se puede anular: .*DEV-BOG-000007/,
      );
    });
  });

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
      expect(receptionCapMessage(0, 'COP', 0)).toMatch(/administración/);
      // D3 (QA): el tope con los decimales de su moneda y su código, sin locale fijo.
      expect(receptionCapMessage(1_000_000, 'COP', 0)).toContain('10000 COP');
      expect(receptionCapMessage(1_000_050, 'USD', 2)).toContain(
        '10000.50 USD',
      );
      expect(receptionCapMessage(500_000, 'JPY', 0)).toContain('5000 JPY');
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
