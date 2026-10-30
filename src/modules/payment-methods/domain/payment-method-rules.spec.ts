import { PaymentMethod, PaymentMethodKind } from '@prisma/client';
import {
  DUPLICATE_REFERENCE_WINDOW_DAYS,
  INITIAL_PAYMENT_METHODS,
  duplicateReferenceWindow,
  legacyPaymentMethodOf,
  normalizeReference,
  paymentMethodNameError,
  referenceError,
} from './payment-method-rules';

describe('payment-method-rules (DX-377)', () => {
  describe('normalizeReference', () => {
    it('quita espacios (también los de dentro) y pasa a mayúsculas', () => {
      expect(normalizeReference('  ab 12\t34 cd ')).toBe('AB1234CD');
    });

    it('vacía o solo espacios es null', () => {
      expect(normalizeReference('   ')).toBeNull();
      expect(normalizeReference(undefined)).toBeNull();
      expect(normalizeReference(null)).toBeNull();
    });
  });

  describe('referenceError', () => {
    it('obligatoria cuando el medio la pide', () => {
      expect(referenceError(undefined, true)).toBe(
        'Este medio de pago pide la referencia del pago.',
      );
      expect(referenceError('  ', true)).not.toBeNull();
    });

    it('opcional cuando el medio no la pide', () => {
      expect(referenceError(undefined, false)).toBeNull();
      expect(referenceError('123', false)).toBeNull();
    });

    it('como mucho 60 caracteres', () => {
      expect(referenceError('1'.repeat(60), true)).toBeNull();
      expect(referenceError('1'.repeat(61), false)).toBe(
        'La referencia admite como mucho 60 caracteres.',
      );
    });
  });

  describe('duplicateReferenceWindow', () => {
    it('cubre 90 días antes y después del pago', () => {
      const paidAt = new Date('2026-06-01T12:00:00.000Z');
      const { from, to } = duplicateReferenceWindow(paidAt);
      expect(DUPLICATE_REFERENCE_WINDOW_DAYS).toBe(90);
      expect(from.toISOString()).toBe('2026-03-03T12:00:00.000Z');
      expect(to.toISOString()).toBe('2026-08-30T12:00:00.000Z');
    });
  });

  describe('legacyPaymentMethodOf', () => {
    it('cada tipo base escribe su método antiguo; DIGITAL como TRANSFER', () => {
      expect(legacyPaymentMethodOf(PaymentMethodKind.CASH)).toBe(
        PaymentMethod.CASH,
      );
      expect(legacyPaymentMethodOf(PaymentMethodKind.CARD)).toBe(
        PaymentMethod.CARD,
      );
      expect(legacyPaymentMethodOf(PaymentMethodKind.TRANSFER)).toBe(
        PaymentMethod.TRANSFER,
      );
      expect(legacyPaymentMethodOf(PaymentMethodKind.DIGITAL)).toBe(
        PaymentMethod.TRANSFER,
      );
      expect(legacyPaymentMethodOf(PaymentMethodKind.OTHER)).toBe(
        PaymentMethod.OTHER,
      );
    });
  });

  it('los medios iniciales son uno por método antiguo', () => {
    expect(INITIAL_PAYMENT_METHODS.map((m) => m.legacyMethod).sort()).toEqual(
      Object.values(PaymentMethod).sort(),
    );
  });

  it('nombre de 1 a 60 caracteres', () => {
    expect(paymentMethodNameError('Pago móvil')).toBeNull();
    expect(paymentMethodNameError('  ')).toBe(
      'El nombre del medio de pago es obligatorio.',
    );
    expect(paymentMethodNameError('x'.repeat(61))).toBe(
      'El nombre del medio de pago admite como mucho 60 caracteres.',
    );
  });
});
