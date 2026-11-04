import { regionalFormat } from '../../../shared/format/regional-format';
import { ClinicRole } from '@prisma/client';
import {
  CREDIT_AMOUNT_EXCEEDS_MESSAGE,
  canMoveCredit,
  creditExceedsMessage,
  dailyRefundCapMessage,
  dailyRefundRemainingCents,
  dailyRefundWindow,
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
      expect(voidRefundReferenceMessage('DEV-CCS-000007')).toMatch(
        /^No se puede anular: .*DEV-CCS-000007/,
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
      const enUS = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
      const esVE = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
      expect(receptionCapMessage(0, 'VES', esVE)).toMatch(/administración/);
      // DX-354b: el tope con el formato de la sede y el código ISO de su moneda.
      expect(receptionCapMessage(1_000_000, 'VES', esVE)).toContain(
        'hasta VES\u00a010.000,00 por operación',
      );
      expect(receptionCapMessage(1_000_050, 'USD', enUS)).toContain(
        'USD\u00a010,000.50',
      );
      // JPY no tiene unidad menor: 0 decimales.
      expect(receptionCapMessage(500_000, 'JPY', enUS)).toContain(
        'JPY\u00a05,000 por',
      );
    });
  });

  it('el motivo se recorta y exige 3–500 caracteres', () => {
    expect(normalizeReason('  Paciente se muda  ')).toBe('Paciente se muda');
    expect(normalizeReason('no')).toBeNull();
    expect(normalizeReason('x'.repeat(501))).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
  });

  it('serie propia DEV-<serie de la sede> y número de 6 cifras', () => {
    expect(refundSeriesOf('CCS')).toBe('DEV-CCS');
    expect(formatRefundNumber('DEV-CCS', 7)).toBe('DEV-CCS-000007');
    expect(() => refundSeriesOf('bad prefix')).toThrow(RangeError);
    expect(() => formatRefundNumber('DEV-CCS', 0)).toThrow(RangeError);
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
      currency: 'ves',
      method: 'CASH' as const,
      reason: 'Motivo',
      paymentIds: ['b', 'a', 'a'],
    };
    expect(refundFingerprint(base)).toBe(
      refundFingerprint({ ...base, currency: 'VES', paymentIds: ['a', 'b'] }),
    );
    expect(refundFingerprint(base)).not.toBe(
      refundFingerprint({ ...base, amountCents: 101 }),
    );
    const transfer = {
      sourcePlanId: 'A',
      targetPlanId: 'B',
      amountCents: 1,
      currency: 'VES',
      reason: null,
    };
    expect(transferFingerprint(transfer)).not.toBe(
      transferFingerprint({ ...transfer, targetPlanId: 'C' }),
    );
  });
});

describe('creditExceedsMessage (DX-472-bis, revisión B3)', () => {
  it('sin abonos en otra moneda pendientes, el mensaje de siempre', () => {
    expect(creditExceedsMessage(0)).toBe(CREDIT_AMOUNT_EXCEEDS_MESSAGE);
  });

  it('con abonos en otra moneda que aún no cuentan, lo explica', () => {
    expect(creditExceedsMessage(2)).toBe(
      'El importe supera el saldo a favor del plan. 2 abonos en otra moneda todavía no cuentan en el saldo a favor: se suman en unos minutos, cuando quede registrada la tasa de su día. Vuelve a intentarlo después.',
    );
  });

  describe('tope diario de devoluciones de RECEPCIÓN (DX-462)', () => {
    const esVE = regionalFormat({ locale: 'es-VE', hourCycle: 'h12' });
    const enUS = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });

    it('lo que queda es el tope menos lo ya devuelto hoy (nunca negativo)', () => {
      expect(dailyRefundRemainingCents(10_000, 6_000)).toBe(4_000);
      expect(dailyRefundRemainingCents(10_000, 10_000)).toBe(0);
      expect(dailyRefundRemainingCents(10_000, 12_000)).toBe(0);
    });

    it('el mensaje dice lo que queda con el formato de la sede y el código ISO', () => {
      expect(dailyRefundCapMessage(4_000, 'USD', enUS)).toBe(
        'Supera tu tope diario de devoluciones en esta sede. Te quedan USD\u00a040.00 hoy; pide a un administrador que la registre.',
      );
      expect(dailyRefundCapMessage(0, 'VES', esVE)).toContain(
        'Te quedan VES\u00a00,00 hoy',
      );
    });

    it('el día es el civil de la sede: Caracas (UTC−4) cerca de la medianoche', () => {
      // 23:30 del 4 nov en Caracas = 03:30Z del 5 nov.
      const late = dailyRefundWindow(
        new Date('2026-11-05T03:30:00Z'),
        'America/Caracas',
      );
      // 00:30 del 5 nov en Caracas = 04:30Z del 5 nov.
      const early = dailyRefundWindow(
        new Date('2026-11-05T04:30:00Z'),
        'America/Caracas',
      );
      expect(late.day).toBe('2026-11-04');
      expect(early.day).toBe('2026-11-05');
      expect(late.end).toEqual(early.start);
      expect(early.start).toEqual(new Date('2026-11-05T04:00:00Z'));
    });

    it('el día es el civil de la sede: Madrid (UTC+1) cerca de la medianoche', () => {
      // 23:30 del 4 nov en Madrid = 22:30Z; 00:30 del 5 nov = 23:30Z.
      const late = dailyRefundWindow(
        new Date('2026-11-04T22:30:00Z'),
        'Europe/Madrid',
      );
      const early = dailyRefundWindow(
        new Date('2026-11-04T23:30:00Z'),
        'Europe/Madrid',
      );
      expect(late.day).toBe('2026-11-04');
      expect(early.day).toBe('2026-11-05');
      expect(late.end).toEqual(early.start);
      expect(early.start).toEqual(new Date('2026-11-04T23:00:00Z'));
    });
  });
});
