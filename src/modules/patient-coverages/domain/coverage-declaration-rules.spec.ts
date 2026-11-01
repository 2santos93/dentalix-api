import { ClinicRole } from '@prisma/client';
import {
  coverageRedeclared,
  coverageValidityChanged,
  type CoverageDeclarationFacts,
} from './coverage-declaration-rules';

describe('redeclarar una cobertura (SEC-049/SEC-053)', () => {
  const verified: CoverageDeclarationFacts = {
    payerId: 'surco',
    memberNumber: '1020304050',
    validFrom: '2025-01-01',
    validTo: '2026-06-30',
    externalPayer: true,
  };
  const NOT_ADMIN = [
    ClinicRole.RECEPTION,
    ClinicRole.ASSISTANT,
    ClinicRole.DENTIST,
  ] as const;

  describe('coverageValidityChanged', () => {
    it('enviar la misma vigencia o no enviarla no es un cambio', () => {
      expect(coverageValidityChanged(verified, {})).toBe(false);
      expect(
        coverageValidityChanged(verified, {
          validFrom: '2025-01-01',
          validTo: '2026-06-30',
        }),
      ).toBe(false);
    });

    it('alargar, acortar, quitar o poner una fecha sí lo es', () => {
      for (const patch of [
        { validTo: '2027-06-30' },
        { validTo: '2026-01-31' },
        { validTo: null },
        { validFrom: null },
        { validFrom: '2024-01-01' },
      ]) {
        expect(coverageValidityChanged(verified, patch)).toBe(true);
      }
      expect(
        coverageValidityChanged(
          { validFrom: null, validTo: null },
          { validTo: '2027-01-01' },
        ),
      ).toBe(true);
    });
  });

  describe('coverageRedeclared', () => {
    it.each(NOT_ADMIN)(
      '%s: cambiar la vigencia de un pagador externo la redeclara (BE-048)',
      (role) => {
        expect(coverageRedeclared(verified, { validTo: null }, role)).toBe(
          true,
        );
        expect(
          coverageRedeclared(verified, { validTo: '2027-06-30' }, role),
        ).toBe(true);
        expect(
          coverageRedeclared(verified, { validFrom: '2024-06-01' }, role),
        ).toBe(true);
      },
    );

    it('ADMIN cambia la vigencia y sigue verificada', () => {
      expect(
        coverageRedeclared(
          verified,
          { validFrom: null, validTo: '2027-06-30' },
          ClinicRole.ADMIN,
        ),
      ).toBe(false);
    });

    it('la vigencia de un pagador interno (OTHER) no la redeclara', () => {
      expect(
        coverageRedeclared(
          { ...verified, externalPayer: false },
          { validTo: null },
          ClinicRole.RECEPTION,
        ),
      ).toBe(false);
    });

    it.each([...NOT_ADMIN, ClinicRole.ADMIN])(
      '%s: la misma vigencia u otros campos (sin pagador ni nº) no la redeclaran',
      (role) => {
        expect(coverageRedeclared(verified, {}, role)).toBe(false);
        expect(
          coverageRedeclared(
            verified,
            {
              payerId: 'surco',
              memberNumber: ' 1020304050 ',
              validFrom: '2025-01-01',
              validTo: '2026-06-30',
            },
            role,
          ),
        ).toBe(false);
      },
    );

    it.each([...NOT_ADMIN, ClinicRole.ADMIN])(
      '%s: cambiar el pagador o el nº la redeclara siempre (SEC-049)',
      (role) => {
        expect(
          coverageRedeclared(verified, { payerId: 'sanavida' }, role),
        ).toBe(true);
        expect(
          coverageRedeclared(verified, { memberNumber: '1020304059' }, role),
        ).toBe(true);
        expect(
          coverageRedeclared(
            { ...verified, externalPayer: false },
            { memberNumber: '1020304059' },
            role,
          ),
        ).toBe(true);
      },
    );
  });
});
