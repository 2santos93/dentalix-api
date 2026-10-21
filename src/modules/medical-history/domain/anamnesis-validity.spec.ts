import {
  ANAMNESIS_VALIDITY_MAX_MONTHS,
  ANAMNESIS_VALIDITY_MIN_MONTHS,
  DEFAULT_ANAMNESIS_VALIDITY_MONTHS,
  addMonthsUtc,
  anamnesisExpiresAt,
  anamnesisStatus,
  isValidAnamnesisValidity,
} from './anamnesis-validity';

const at = (iso: string) => new Date(iso);

describe('Vigencia de la anamnesis (DX-247)', () => {
  it('12 meses por defecto, entre 1 y 60', () => {
    expect(DEFAULT_ANAMNESIS_VALIDITY_MONTHS).toBe(12);
    expect(ANAMNESIS_VALIDITY_MIN_MONTHS).toBe(1);
    expect(ANAMNESIS_VALIDITY_MAX_MONTHS).toBe(60);
    expect(isValidAnamnesisValidity(1)).toBe(true);
    expect(isValidAnamnesisValidity(60)).toBe(true);
    expect(isValidAnamnesisValidity(0)).toBe(false);
    expect(isValidAnamnesisValidity(61)).toBe(false);
    expect(isValidAnamnesisValidity(6.5)).toBe(false);
  });

  describe('addMonthsUtc', () => {
    it('suma meses de calendario conservando la hora', () => {
      expect(
        addMonthsUtc(at('2025-10-20T15:30:00.000Z'), 12).toISOString(),
      ).toBe('2026-10-20T15:30:00.000Z');
      expect(
        addMonthsUtc(at('2025-11-05T00:00:00.000Z'), 3).toISOString(),
      ).toBe('2026-02-05T00:00:00.000Z');
    });

    it('un día que no existe en el mes de destino queda en su último día', () => {
      expect(
        addMonthsUtc(at('2026-01-31T10:00:00.000Z'), 1).toISOString(),
      ).toBe('2026-02-28T10:00:00.000Z');
      expect(
        addMonthsUtc(at('2024-02-29T10:00:00.000Z'), 12).toISOString(),
      ).toBe('2025-02-28T10:00:00.000Z');
    });
  });

  it('caduca a los N meses de la última revisión', () => {
    expect(
      anamnesisExpiresAt(at('2025-10-20T15:00:00.000Z'), 12).toISOString(),
    ).toBe('2026-10-20T15:00:00.000Z');
  });

  describe('anamnesisStatus', () => {
    const now = at('2026-10-20T15:00:00.000Z');

    it('sin anamnesis → MISSING (no es «al día» ni «sin alertas»)', () => {
      expect(anamnesisStatus(null, 12, now)).toBe('MISSING');
    });

    it('revisada dentro de la vigencia → CURRENT', () => {
      expect(anamnesisStatus(at('2026-01-10T12:00:00.000Z'), 12, now)).toBe(
        'CURRENT',
      );
      // Un instante antes de cumplir la vigencia sigue al día.
      expect(anamnesisStatus(at('2025-10-20T15:00:00.001Z'), 12, now)).toBe(
        'CURRENT',
      );
    });

    it('justo al cumplir la vigencia o después → EXPIRED', () => {
      expect(anamnesisStatus(at('2025-10-20T15:00:00.000Z'), 12, now)).toBe(
        'EXPIRED',
      );
      expect(anamnesisStatus(at('2024-03-01T00:00:00.000Z'), 12, now)).toBe(
        'EXPIRED',
      );
    });

    it('la vigencia de la clínica manda: 6 meses caduca antes que 12', () => {
      const reviewed = at('2026-02-01T00:00:00.000Z');
      expect(anamnesisStatus(reviewed, 12, now)).toBe('CURRENT');
      expect(anamnesisStatus(reviewed, 6, now)).toBe('EXPIRED');
    });
  });
});
