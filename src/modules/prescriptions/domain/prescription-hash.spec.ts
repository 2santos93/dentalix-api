import {
  computePrescriptionHash,
  roundWeightKg,
  type PrescriptionHashInput,
} from './prescription-hash';
import type { SafetyAlert } from './prescription-safety';

const base: PrescriptionHashInput = {
  country: 'CO',
  issuedAt: new Date('2026-10-16T15:00:00.000Z'),
  dispensationDate: '2026-10-16',
  validUntil: '2026-11-14',
  patientId: 'p1',
  patientName: 'Ana Pérez',
  patientDocument: 'CC 123',
  patientBirthYear: null,
  clinicalRecordNumber: '123',
  professionalId: 'u1',
  professionalName: 'Dra. Ruiz',
  professionalLicense: 'RM-1',
  professionalEmail: null,
  clinicName: 'Clínica',
  locationName: 'Sede',
  locationAddress: null,
  notes: null,
  allergyOverride: false,
  allergyMatches: [],
  // Receta de antes de DX-300: sin avisos de seguridad (formato v1).
  safetyRulesVersion: null,
  safetyAlerts: null,
  safetyOverrideReason: null,
  items: [
    {
      position: 1,
      activeIngredient: 'Amoxicilina',
      brandName: null,
      concentration: '500 mg',
      pharmaceuticalForm: 'Cápsula',
      route: 'Oral',
      dose: '1 cápsula',
      frequency: 'Cada 8 horas',
      durationDays: 7,
      totalQuantity: 21,
      quantityUnit: 'cápsulas',
      quantityInWords: 'veintiuno',
      packages: null,
      instructions: null,
    },
  ],
};

describe('computePrescriptionHash', () => {
  it('es un SHA-256 hex estable', () => {
    const hash = computePrescriptionHash(base);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(computePrescriptionHash({ ...base })).toBe(hash);
  });

  it('cambia con cualquier dato del contenido, también de un medicamento', () => {
    const hash = computePrescriptionHash(base);
    expect(
      computePrescriptionHash({ ...base, patientName: 'Ana Perez' }),
    ).not.toBe(hash);
    expect(
      computePrescriptionHash({
        ...base,
        items: [{ ...base.items[0], totalQuantity: 22 }],
      }),
    ).not.toBe(hash);
  });

  it('no confunde fronteras entre campos', () => {
    expect(
      computePrescriptionHash({ ...base, clinicName: 'ab', locationName: 'c' }),
    ).not.toBe(
      computePrescriptionHash({ ...base, clinicName: 'a', locationName: 'bc' }),
    );
  });

  it('legacy v1 hash is unchanged', () => {
    // Valor calculado con el código de DX-013 antes de la migración: si el
    // formato v1 cambiara, las recetas ya emitidas dejarían de validar.
    expect(
      computePrescriptionHash({
        ...base,
        allergyOverride: true,
        allergyMatches: [
          { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
        ],
      }),
    ).toBe('6b6384eb06021c3f7bb9eb02f5677252d60455d301b08c9b7e64f04981a569d7');
  });

  describe('legacy v2 vectors are unchanged', () => {
    const alert: SafetyAlert = {
      rule: 'INTERACTION',
      code: 'INTERACTION_ANTICOAGULANT_NSAID',
      severity: 'BLOCKING',
      activeIngredient: 'Ibuprofeno',
      message: 'Interacción grave',
      source: 'SDCEP',
    };
    const v2: PrescriptionHashInput = {
      ...base,
      safetyRulesVersion: 'RX_SAFETY_V1',
      safetyAlerts: [alert],
      safetyOverrideReason: 'Pauta corta pactada con hematología',
    };

    it('golden v2 values computed by the code at 1a505688 (before DX-324)', () => {
      expect(computePrescriptionHash(v2)).toBe(
        '4d62a31c9a5c39c93860a49999c52aa0493bc25c016abf6721bb8e168a14b8d4',
      );
      expect(
        computePrescriptionHash({
          ...base,
          safetyRulesVersion: 'RX_SAFETY_V1',
          safetyAlerts: [],
        }),
      ).toBe(
        '3d537eee8c8dc8f72e91802cbea0c14c7b513c233dda2a26fb5339249481ba04',
      );
    });

    it('una receta nueva sin avisos ([]) ya no usa el formato v1', () => {
      expect(
        computePrescriptionHash({
          ...base,
          safetyRulesVersion: 'RX_SAFETY_V1',
          safetyAlerts: [],
        }),
      ).not.toBe(computePrescriptionHash(base));
    });

    it('cambia con el motivo, con un aviso o con la versión de las reglas', () => {
      const hash = computePrescriptionHash(v2);
      expect(
        computePrescriptionHash({ ...v2, safetyOverrideReason: 'Otro' }),
      ).not.toBe(hash);
      expect(
        computePrescriptionHash({
          ...v2,
          safetyAlerts: [{ ...alert, severity: 'INFO' }],
        }),
      ).not.toBe(hash);
      expect(
        computePrescriptionHash({ ...v2, safetyRulesVersion: 'RX_SAFETY_V2' }),
      ).not.toBe(hash);
    });
  });

  describe('DX-324: single-format v3', () => {
    const LEGACY_V1 =
      '6b6384eb06021c3f7bb9eb02f5677252d60455d301b08c9b7e64f04981a569d7';
    const LEGACY_V2 =
      '4d62a31c9a5c39c93860a49999c52aa0493bc25c016abf6721bb8e168a14b8d4';
    // Entradas de las dos recetas guardadas (v1 y v2), sin ninguna clave nueva.
    const storedV1: PrescriptionHashInput = {
      ...base,
      allergyOverride: true,
      allergyMatches: [
        { activeIngredient: 'Amoxicilina', allergen: 'Penicilina' },
      ],
    };
    const storedV2: PrescriptionHashInput = {
      ...base,
      safetyRulesVersion: 'RX_SAFETY_V1',
      safetyAlerts: [
        {
          rule: 'INTERACTION',
          code: 'INTERACTION_ANTICOAGULANT_NSAID',
          severity: 'BLOCKING',
          activeIngredient: 'Ibuprofeno',
          message: 'Interacción grave',
          source: 'SDCEP',
        },
      ],
      safetyOverrideReason: 'Pauta corta pactada con hematología',
    };
    const newFields = {
      printQuantityInWords: true,
      professionalSpecialty: 'Endodoncia',
      patientAgeYears: 41,
      patientWeightKg: 72.5,
    } satisfies Partial<PrescriptionHashInput>;

    const single: PrescriptionHashInput = {
      ...base,
      singleFormat: true,
      issuedAt: new Date('2027-05-03T01:00:00.000Z'),
      dispensationDate: '2027-05-03',
      validUntil: '2027-06-01',
      patientDocument: 'Doc. 123',
      patientBirthYear: 1985,
      ...newFields,
      safetyRulesVersion: 'RX_SAFETY_V1',
      safetyAlerts: [],
      safetyOverrideReason: null,
    };

    it('stored v1 and v2 hashes recompute byte for byte with the new optional fields absent', () => {
      expect(Object.keys(storedV1)).not.toContain('singleFormat');
      expect(computePrescriptionHash(storedV1)).toBe(LEGACY_V1);
      expect(computePrescriptionHash(storedV2)).toBe(LEGACY_V2);
      // Con las claves nuevas presentes pero `singleFormat` ausente, también.
      expect(computePrescriptionHash({ ...storedV1, ...newFields })).toBe(
        LEGACY_V1,
      );
      expect(computePrescriptionHash({ ...storedV2, ...newFields })).toBe(
        LEGACY_V2,
      );
    });

    it('a legacy snapshot ignores the new fields', () => {
      const legacy = { ...storedV2, singleFormat: false };
      expect(computePrescriptionHash(legacy)).toBe(LEGACY_V2);
      expect(
        computePrescriptionHash({
          ...legacy,
          ...newFields,
          printQuantityInWords: false,
          patientAgeYears: 9,
        }),
      ).toBe(LEGACY_V2);
    });

    it('v3 for a single-format snapshot', () => {
      // Orden (spec §3.3): versión, issuedAt, dispensationDate, validUntil,
      // patientId, patientName, patientDocument, patientBirthYear,
      // patientAgeYears, patientWeightKg, clinicalRecordNumber, professionalId,
      // professionalName, professionalLicense, professionalSpecialty,
      // professionalEmail, clinicName, locationName, locationAddress, notes,
      // allergyOverride, printQuantityInWords, allergyMatches, items (con las
      // letras solo si se imprimen), safetyRulesVersion, safetyAlerts y
      // safetyOverrideReason. Sin país. Valor calculado una vez y pegado.
      expect(computePrescriptionHash(single)).toBe(
        'a2238dde6750c8d81b6efb908c64b15145cc6b20f3821d74fd3404781aca827e',
      );
    });

    it('v3 changes when any new field changes and never contains the country', () => {
      const hash = computePrescriptionHash(single);
      for (const change of [
        { professionalSpecialty: 'Ortodoncia' },
        { professionalSpecialty: null },
        { patientAgeYears: 42 },
        { patientAgeYears: null },
        { patientWeightKg: 72.6 },
        { patientWeightKg: null },
        { clinicalRecordNumber: null },
        { printQuantityInWords: false },
      ] satisfies Partial<PrescriptionHashInput>[]) {
        expect({
          change,
          same: computePrescriptionHash({ ...single, ...change }) === hash,
        }).toEqual({ change, same: false });
      }
      expect(computePrescriptionHash({ ...single, country: 'CO' })).toBe(
        computePrescriptionHash({ ...single, country: 'ES' }),
      );

      const noWords = { ...single, printQuantityInWords: false };
      expect(
        computePrescriptionHash({
          ...noWords,
          items: [{ ...noWords.items[0], quantityInWords: 'otra cosa' }],
        }),
      ).toBe(computePrescriptionHash(noWords));
      expect(
        computePrescriptionHash({
          ...single,
          items: [{ ...single.items[0], quantityInWords: 'otra cosa' }],
        }),
      ).not.toBe(hash);
    });

    it('v3 without safetyAlerts throws', () => {
      expect(() =>
        computePrescriptionHash({ ...single, safetyAlerts: null }),
      ).toThrow();
    });
  });

  it('roundWeightKg', () => {
    // 72,55 es 72,5499… en binario (×10 = 725,4999…), así que redondea a 72,5.
    // No se «arregla» a 72,6: el peso guardado y el hash de las recetas
    // emitidas dependen de ello.
    expect(roundWeightKg(72.55)).toBe(72.5);
    expect(roundWeightKg(72.56)).toBe(72.6);
    expect(roundWeightKg(18)).toBe(18);
  });
});
