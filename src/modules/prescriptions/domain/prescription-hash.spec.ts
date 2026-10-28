import { roundWeightKg } from './patient-snapshot';
import {
  computePrescriptionHash,
  expectedPrescriptionHash,
  type PrescriptionHashInput,
  type StoredPrescriptionHashInput,
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

  it('legacy v1 and v2 without their country do not compile, and throw if they arrive untyped; v3 needs none', () => {
    const { country: _c, ...noCountry } = base;
    // @ts-expect-error una legada exige su país en compilación.
    const v1: PrescriptionHashInput = noCountry;
    // @ts-expect-error tampoco con `singleFormat: false` explícito.
    const v2: PrescriptionHashInput = {
      ...noCountry,
      safetyRulesVersion: 'RX_SAFETY_V1',
      safetyAlerts: [],
      singleFormat: false,
    };
    // Segunda guarda en ejecución, para lo que llegue sin tipar.
    for (const input of [v1, v2]) {
      expect(() => computePrescriptionHash(input)).toThrow(
        'Una receta legada se sella siempre con su país',
      );
    }
    expect(
      computePrescriptionHash({
        ...noCountry,
        safetyRulesVersion: 'RX_SAFETY_V1',
        safetyAlerts: [],
        singleFormat: true,
        printQuantityInWords: false,
      }),
    ).toMatch(/^[0-9a-f]{64}$/);
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
      const legacy = { ...storedV2, singleFormat: false as const };
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

    it('v3 without safetyAlerts does not compile and throws if it arrives untyped', () => {
      // @ts-expect-error la v3 exige la lista de avisos.
      const input: PrescriptionHashInput = { ...single, safetyAlerts: null };
      expect(() => computePrescriptionHash(input)).toThrow();
    });

    it('v3 without a real printQuantityInWords boolean does not compile and throws if it arrives untyped', () => {
      const { printQuantityInWords: _omitted, ...absent } = single;
      // Sin tipar a propósito: la segunda guarda en ejecución.
      for (const input of [
        absent,
        { ...single, printQuantityInWords: undefined },
        { ...single, printQuantityInWords: null },
      ] as unknown as PrescriptionHashInput[]) {
        expect(() => computePrescriptionHash(input)).toThrow(
          'printQuantityInWords',
        );
      }
      // @ts-expect-error la v3 exige el booleano de las letras.
      const nullWords: PrescriptionHashInput = {
        ...single,
        printQuantityInWords: null,
      };
      expect(nullWords.singleFormat).toBe(true);
    });

    describe('expectedPrescriptionHash (lectura de una receta guardada)', () => {
      const stored = (
        over: Partial<StoredPrescriptionHashInput>,
      ): StoredPrescriptionHashInput => ({
        ...base,
        singleFormat: false,
        printQuantityInWords: null,
        ...over,
      });

      it('picks the format from the snapshot and matches the sealed hashes', () => {
        expect(
          expectedPrescriptionHash(
            stored({ ...storedV1, singleFormat: false }),
          ),
        ).toBe(LEGACY_V1);
        expect(
          expectedPrescriptionHash(
            stored({ ...storedV2, singleFormat: false }),
          ),
        ).toBe(LEGACY_V2);
        expect(
          expectedPrescriptionHash({
            ...stored({}),
            ...single,
            singleFormat: true,
            printQuantityInWords: true,
            // La fila de fase 1 trae el país copiado: no entra en la v3.
            country: 'ES',
          }),
        ).toBe(computePrescriptionHash(single));
      });

      it('returns null, never throws, for a row that cannot be sealed with its format', () => {
        for (const row of [
          stored({ singleFormat: false, country: null }),
          stored({
            singleFormat: true,
            printQuantityInWords: null,
            safetyAlerts: [],
          }),
          stored({
            singleFormat: true,
            printQuantityInWords: true,
            safetyAlerts: null,
          }),
        ]) {
          expect(expectedPrescriptionHash(row)).toBeNull();
        }
      });
    });

    it.each([true, false])(
      'v3 round-trips through the stored row with printQuantityInWords %s',
      (printQuantityInWords) => {
        const sealed = { ...single, printQuantityInWords };
        // Lo que vuelve de la fila: JSON sin `Date`, que el repositorio rehace.
        const row = JSON.parse(JSON.stringify(sealed)) as PrescriptionHashInput;
        const read = { ...row, issuedAt: new Date(row.issuedAt) };
        expect(computePrescriptionHash(read)).toBe(
          computePrescriptionHash(sealed),
        );
        expect(computePrescriptionHash(sealed)).not.toBe(
          computePrescriptionHash({
            ...sealed,
            printQuantityInWords: !printQuantityInWords,
          }),
        );
      },
    );

    it('a legacy snapshot still hashes with printQuantityInWords absent', () => {
      expect(
        computePrescriptionHash({
          ...storedV2,
          printQuantityInWords: undefined,
        }),
      ).toBe(LEGACY_V2);
    });
  });

  it('the hash seals the weight rounded by the country-free snapshot helper', () => {
    expect(roundWeightKg(72.55)).toBe(72.5);
  });
});
