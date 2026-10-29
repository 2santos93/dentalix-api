/**
 * Excepción G5.3 (DX-334): tipos de pagador anteriores a DX-326.
 */
import { $Enums } from '@prisma/client';
import { PAYER_TYPES } from './payer-type';
import {
  LEGACY_PAYER_TYPES,
  legacyPayerTypeAlias,
  payerTypeFromCode,
  payerTypeFromStored,
  storedPayerType,
} from './legacy-payer-type';

describe('legacy-payer-type', () => {
  it('legacy codes map one to one to the generic types', () => {
    expect(LEGACY_PAYER_TYPES).toEqual({
      MUTUA_ES: 'INSURER',
      PREPAGADA_CO: 'PREPAID_PLAN',
      EPS_CO: 'PUBLIC_SYSTEM',
      EMPRESA: 'EMPLOYER',
      OTRO: 'OTHER',
    });
    for (const [code, type] of Object.entries(LEGACY_PAYER_TYPES)) {
      expect(payerTypeFromCode(code)).toBe(type);
    }
  });

  it('generic codes map to themselves', () => {
    for (const type of PAYER_TYPES) expect(payerTypeFromCode(type)).toBe(type);
  });

  it('payerTypeFromStored covers every value of the stored enum', () => {
    const stored = Object.values($Enums.PayerType);
    expect(stored).toHaveLength(10);
    const mapped = stored.map((value) => payerTypeFromStored(value));
    expect(new Set(mapped)).toEqual(new Set(PAYER_TYPES));
  });

  it('payerTypeFromStored throws on an unknown code', () => {
    expect(() =>
      payerTypeFromStored('DESCONOCIDO' as unknown as $Enums.PayerType),
    ).toThrow('DESCONOCIDO');
  });

  it('storedPayerType writes the legacy code in phase 1 and round-trips', () => {
    for (const type of PAYER_TYPES) {
      expect(payerTypeFromStored(storedPayerType(type))).toBe(type);
    }
    expect(storedPayerType('INSURER')).toBe('MUTUA_ES');
  });

  it('payerTypeFromCode returns null for an unknown code, also for lower case and prototype keys', () => {
    for (const code of ['X', 'insurer', 'constructor', '__proto__']) {
      expect(payerTypeFromCode(code)).toBeNull();
    }
  });

  it('legacyPayerTypeAlias maps legacy input codes and leaves the rest untouched', () => {
    expect(legacyPayerTypeAlias('EPS_CO')).toBe('PUBLIC_SYSTEM');
    for (const value of ['INSURER', 'X', 'constructor', null, undefined, 3]) {
      expect(legacyPayerTypeAlias(value)).toBe(value);
    }
  });
});
