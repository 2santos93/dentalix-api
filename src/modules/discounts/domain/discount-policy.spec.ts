import { ClinicRole, DiscountReason } from '@prisma/client';
import {
  DEFAULT_DISCOUNT_POLICY,
  checkItemDiscount,
  discountForPercent,
  discountPercent,
  roleDiscountCapMessage,
} from './discount-policy';
import { REFERENCE_CURRENCY_DIGITS } from '../../../shared/money/__fixtures__/reference-currency-digits';

// DX-340: los dígitos de redondeo salen de `currencies.rounding_digits` (aquí,
// de la referencia versionada que rellena la migración).
const digits = (code: string) => REFERENCE_CURRENCY_DIGITS.roundingDigits(code);

describe('política de descuentos (DX-204)', () => {
  describe('valores por defecto', () => {
    it('ADMIN 100 %, DENTIST 10 %, el resto 0 %; motivo por encima del 10 %', () => {
      expect(DEFAULT_DISCOUNT_POLICY.maxPercentByRole).toEqual({
        ADMIN: 100,
        DENTIST: 10,
        ASSISTANT: 0,
        RECEPTION: 0,
      });
      expect(DEFAULT_DISCOUNT_POLICY.reasonRequiredAbovePercent).toBe(10);
    });
  });

  describe('checkItemDiscount', () => {
    const policy = DEFAULT_DISCOUNT_POLICY;

    it('un DENTIST no puede dar un 15 %: tope del rol', () => {
      expect(
        checkItemDiscount(policy, ClinicRole.DENTIST, {
          price: 1000,
          discount: 150,
          reason: DiscountReason.LOYALTY,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'over-cap', maxPercent: 10 });
    });

    it('un DENTIST sí puede dar justo su tope (10 %) sin motivo', () => {
      expect(
        checkItemDiscount(policy, ClinicRole.DENTIST, {
          price: 1000,
          discount: 100,
          reason: null,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('compara en céntimos: 10,01 % supera el 10 %', () => {
      expect(
        checkItemDiscount(policy, ClinicRole.DENTIST, {
          price: 999.9,
          discount: 100,
          reason: null,
          reasonNote: null,
        }).kind,
      ).toBe('over-cap');
    });

    it('la asistente (0 %) no puede descontar nada, pero sí quitar un descuento', () => {
      const input = { price: 100, reason: null, reasonNote: null };
      expect(
        checkItemDiscount(policy, ClinicRole.ASSISTANT, {
          ...input,
          discount: 0.01,
        }),
      ).toEqual({ kind: 'over-cap', maxPercent: 0 });
      expect(
        checkItemDiscount(policy, ClinicRole.ASSISTANT, {
          ...input,
          discount: 0,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('por encima del umbral exige el motivo', () => {
      expect(
        checkItemDiscount(policy, ClinicRole.ADMIN, {
          price: 1000,
          discount: 150,
          reason: null,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'reason-required', thresholdPercent: 10 });
      expect(
        checkItemDiscount(policy, ClinicRole.ADMIN, {
          price: 1000,
          discount: 150,
          reason: DiscountReason.PROMOTION,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('«Otro» exige una nota', () => {
      expect(
        checkItemDiscount(policy, ClinicRole.ADMIN, {
          price: 1000,
          discount: 150,
          reason: DiscountReason.OTHER,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'note-required' });
      expect(
        checkItemDiscount(policy, ClinicRole.ADMIN, {
          price: 1000,
          discount: 150,
          reason: DiscountReason.OTHER,
          reasonNote: 'Acuerdo con la aseguradora',
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('un precio 0 con descuento 0 es válido para cualquier rol', () => {
      expect(
        checkItemDiscount(policy, ClinicRole.RECEPTION, {
          price: 0,
          discount: 0,
          reason: null,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'ok' });
    });

    it('respeta una política propia de la clínica', () => {
      const custom = {
        maxPercentByRole: {
          ADMIN: 50,
          DENTIST: 20,
          ASSISTANT: 5,
          RECEPTION: 0,
        },
        reasonRequiredAbovePercent: 0,
      };
      expect(
        checkItemDiscount(custom, ClinicRole.ADMIN, {
          price: 100,
          discount: 60,
          reason: DiscountReason.LOYALTY,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'over-cap', maxPercent: 50 });
      expect(
        checkItemDiscount(custom, ClinicRole.ASSISTANT, {
          price: 100,
          discount: 1,
          reason: null,
          reasonNote: null,
        }),
      ).toEqual({ kind: 'reason-required', thresholdPercent: 0 });
    });
  });

  it('el mensaje del tope está en español', () => {
    expect(roleDiscountCapMessage(10)).toBe(
      'Tu rol permite hasta un 10 % de descuento por ítem.',
    );
  });

  describe('discountPercent', () => {
    it('es el % sobre el precio, con dos decimales', () => {
      expect(discountPercent(1000, 150)).toBe(15);
      expect(discountPercent(3, 1)).toBe(33.33);
      expect(discountPercent(0, 0)).toBe(0);
    });
  });

  describe('redondeo por moneda', () => {
    it('COP (y CLP) sin decimales; EUR, USD a céntimos', () => {
      expect(digits('COP')).toBe(0);
      expect(digits('CLP')).toBe(0);
      expect(digits('EUR')).toBe(2);
      expect(digits('USD')).toBe(2);
    });

    it('discountForPercent: 7,5 % de tres precios en COP sin decimales', () => {
      expect(discountForPercent(85000, 7.5, digits('COP'), 10)).toBe(6375);
      expect(discountForPercent(123457, 7.5, digits('COP'), 10)).toBe(9259);
      expect(discountForPercent(99999, 7.5, digits('COP'), 10)).toBe(7500);
    });

    it('discountForPercent: en EUR a céntimos', () => {
      expect(discountForPercent(85.55, 7.5, digits('EUR'), 10)).toBe(6.42);
      expect(discountForPercent(123.45, 7.5, digits('EUR'), 10)).toBe(9.26);
      expect(discountForPercent(0.99, 7.5, digits('EUR'), 10)).toBe(0.07);
    });

    it('si el redondeo pasara del tope del rol, baja a la unidad que lo respeta', () => {
      // 10 % de 1005 = 100,5 → redondeado 101 (10,05 %) > 10 % → 100.
      expect(discountForPercent(1005, 10, digits('COP'), 10)).toBe(100);
      // EUR: 10 % de 10,05 = 1,005 → 1,01 (10,05 %) > 10 % → 1,00.
      expect(discountForPercent(10.05, 10, digits('EUR'), 10)).toBe(1);
    });

    it('nunca supera el precio', () => {
      expect(discountForPercent(0.5, 100, digits('COP'), 100)).toBe(0);
      expect(discountForPercent(1500, 100, digits('COP'), 100)).toBe(1500);
    });
  });
});
