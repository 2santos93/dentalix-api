import {
  ANAMNESIS_VALIDITY_MAX_MONTHS,
  ANAMNESIS_VALIDITY_MIN_MONTHS,
  DEFAULT_ANAMNESIS_VALIDITY_MONTHS,
  addCivilMonths,
  anamnesisExpiresOn,
  anamnesisStatus,
  isValidAnamnesisValidity,
} from './anamnesis-validity';

const at = (iso: string) => new Date(iso);
const TZ = 'America/Bogota';

describe('Vigencia de la anamnesis por día civil de la sede (DX-247)', () => {
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

  describe('addCivilMonths', () => {
    it('suma meses de calendario a un día civil', () => {
      expect(addCivilMonths('2025-10-20', 12)).toBe('2026-10-20');
      expect(addCivilMonths('2025-11-05', 3)).toBe('2026-02-05');
      expect(addCivilMonths('2026-03-15', -14)).toBe('2025-01-15');
    });

    it('fin de mes: 31 de enero + 1 mes es el último día de febrero', () => {
      expect(addCivilMonths('2026-01-31', 1)).toBe('2026-02-28');
      expect(addCivilMonths('2028-01-31', 1)).toBe('2028-02-29');
    });

    it('29 de febrero + 12 meses es el 28 de febrero', () => {
      expect(addCivilMonths('2024-02-29', 12)).toBe('2025-02-28');
      expect(addCivilMonths('2024-02-29', 48)).toBe('2028-02-29');
    });
  });

  it('caduca el día civil de la revisión en la sede más N meses', () => {
    // 23:30 del 20/10 en la zona de la sede ya es el 21/10 en UTC: cuenta el 20 de la sede.
    expect(anamnesisExpiresOn(at('2025-10-21T04:30:00.000Z'), 12, TZ)).toBe(
      '2026-10-20',
    );
    expect(anamnesisExpiresOn(at('2025-10-21T04:30:00.000Z'), 12, 'UTC')).toBe(
      '2026-10-21',
    );
  });

  describe('anamnesisStatus', () => {
    const reviewed = at('2025-10-21T15:00:00.000Z'); // 10:00 en la zona de la sede

    it('sin anamnesis → MISSING', () => {
      expect(anamnesisStatus(null, 12, '2026-10-21', TZ)).toBe('MISSING');
    });

    it('12 meses exactos: el mismo día civil ya está caducada; la víspera, al día', () => {
      expect(anamnesisStatus(reviewed, 12, '2026-10-20', TZ)).toBe('CURRENT');
      expect(anamnesisStatus(reviewed, 12, '2026-10-21', TZ)).toBe('EXPIRED');
      expect(anamnesisStatus(reviewed, 12, '2026-11-02', TZ)).toBe('EXPIRED');
    });

    it('no cambia a mitad de la jornada: todo el día de la cita vale lo mismo', () => {
      // Lo decide el día de la cita, no la hora a la que se mira.
      expect(anamnesisStatus(reviewed, 12, '2026-10-21', TZ)).toBe('EXPIRED');
    });

    it('revisada a las 23:30 de Bogotá: cuenta el día de la sede, no el de UTC', () => {
      const late = at('2025-10-21T04:30:00.000Z'); // 20/10 23:30 en la zona de la sede
      expect(anamnesisStatus(late, 12, '2026-10-19', TZ)).toBe('CURRENT');
      expect(anamnesisStatus(late, 12, '2026-10-20', TZ)).toBe('EXPIRED');
    });

    it('fin de mes y 29 de febrero', () => {
      const jan31 = at('2026-01-31T15:00:00.000Z');
      expect(anamnesisStatus(jan31, 1, '2026-02-27', TZ)).toBe('CURRENT');
      expect(anamnesisStatus(jan31, 1, '2026-02-28', TZ)).toBe('EXPIRED');
      const leap = at('2024-02-29T15:00:00.000Z');
      expect(anamnesisStatus(leap, 12, '2025-02-27', TZ)).toBe('CURRENT');
      expect(anamnesisStatus(leap, 12, '2025-02-28', TZ)).toBe('EXPIRED');
    });

    it('la vigencia de la clínica manda: 6 meses caduca antes que 12', () => {
      const feb = at('2026-02-01T15:00:00.000Z');
      expect(anamnesisStatus(feb, 12, '2026-10-21', TZ)).toBe('CURRENT');
      expect(anamnesisStatus(feb, 6, '2026-10-21', TZ)).toBe('EXPIRED');
    });
  });
});
