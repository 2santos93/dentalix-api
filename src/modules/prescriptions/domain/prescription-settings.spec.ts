import {
  isValidPrescriptionValidityDays,
  PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS,
  PRESCRIPTION_VALIDITY_DAYS_MAX,
  PRESCRIPTION_VALIDITY_DAYS_MESSAGE,
  PRESCRIPTION_VALIDITY_DAYS_MIN,
  prescriptionSettingsCode,
} from './prescription-settings';

describe('prescription settings', () => {
  it('platform defaults are false, false and 30', () => {
    expect(PLATFORM_DEFAULT_PRESCRIPTION_SETTINGS).toEqual({
      printQuantityInWords: false,
      requireClinicalRecordNumber: false,
      validityDays: 30,
    });
    expect([
      PRESCRIPTION_VALIDITY_DAYS_MIN,
      PRESCRIPTION_VALIDITY_DAYS_MAX,
    ]).toEqual([1, 365]);
    expect(PRESCRIPTION_VALIDITY_DAYS_MESSAGE).toBe(
      'La validez de la receta tiene que ser un número entero de días entre 1 y 365.',
    );
  });

  it('isValidPrescriptionValidityDays accepts 1..365 integers only', () => {
    for (const value of [0, 366, 1.5, '30', null]) {
      expect({ value, valid: isValidPrescriptionValidityDays(value) }).toEqual({
        value,
        valid: false,
      });
    }
    for (const value of [1, 30, 365]) {
      expect({ value, valid: isValidPrescriptionValidityDays(value) }).toEqual({
        value,
        valid: true,
      });
    }
  });

  it('RX_W1_H0_V30', () => {
    expect(
      prescriptionSettingsCode({
        printQuantityInWords: true,
        requireClinicalRecordNumber: false,
        validityDays: 30,
      }),
    ).toBe('RX_W1_H0_V30');
  });

  it('RX_W0_H1_V365', () => {
    expect(
      prescriptionSettingsCode({
        printQuantityInWords: false,
        requireClinicalRecordNumber: true,
        validityDays: 365,
      }),
    ).toBe('RX_W0_H1_V365');
  });
});
