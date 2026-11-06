import {
  PROFESSIONAL_LICENSE_MISSING_MESSAGE,
  licenseSnapshot,
  signingWarnings,
} from './author-license';

describe('licenseSnapshot (DX-540)', () => {
  it('guarda el registro recortado', () => {
    expect(licenseSnapshot('  RP-12345 ')).toBe('RP-12345');
  });

  it('sin registro, vacío o solo espacios → null', () => {
    expect(licenseSnapshot(null)).toBeNull();
    expect(licenseSnapshot(undefined)).toBeNull();
    expect(licenseSnapshot('')).toBeNull();
    expect(licenseSnapshot('   ')).toBeNull();
  });
});

describe('signingWarnings (DX-540)', () => {
  it('aviso activo y autor sin registro → PROFESSIONAL_LICENSE_MISSING', () => {
    expect(
      signingWarnings({
        warnMissingProfessionalLicense: true,
        professionalLicense: null,
      }),
    ).toEqual([
      {
        code: 'PROFESSIONAL_LICENSE_MISSING',
        message: PROFESSIONAL_LICENSE_MISSING_MESSAGE,
      },
    ]);
  });

  it('aviso activo y autor con registro → sin avisos', () => {
    expect(
      signingWarnings({
        warnMissingProfessionalLicense: true,
        professionalLicense: 'RP-12345',
      }),
    ).toEqual([]);
  });

  it('aviso desactivado → nunca avisa, tenga o no registro', () => {
    for (const professionalLicense of [null, 'RP-1']) {
      expect(
        signingWarnings({
          warnMissingProfessionalLicense: false,
          professionalLicense,
        }),
      ).toEqual([]);
    }
  });

  it('un registro en blanco cuenta como ausente', () => {
    expect(
      signingWarnings({
        warnMissingProfessionalLicense: true,
        professionalLicense: '  ',
      }),
    ).toHaveLength(1);
  });

  it('el mensaje es en español y no nombra un país ni una norma', () => {
    expect(PROFESSIONAL_LICENSE_MISSING_MESSAGE).toMatch(
      /registro profesional/,
    );
  });
});
