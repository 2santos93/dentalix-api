import {
  leadHoursError,
  normalizeLeadHours,
  settingsError,
} from './reminder-lead-hours';

describe('antelaciones de recordatorio (DX-026)', () => {
  it('ordena de mayor a menor (el primero que sale es el de más antelación)', () => {
    expect(normalizeLeadHours([2, 48, 24])).toEqual([48, 24, 2]);
  });

  it('acepta de 1 h a 7 días (168 h) y hasta 3 antelaciones', () => {
    expect(leadHoursError([1, 168, 24])).toBeNull();
    expect(leadHoursError([])).toBeNull();
  });

  it('rechaza más de 3, fuera de 1..168, decimales o repetidas, en español', () => {
    expect(leadHoursError([1, 2, 3, 4])).toBe(
      'Como máximo 3 recordatorios por sede.',
    );
    expect(leadHoursError([0])).toBe(
      'Cada recordatorio debe ser de 1 a 168 horas antes (7 días).',
    );
    expect(leadHoursError([169])).toBe(
      'Cada recordatorio debe ser de 1 a 168 horas antes (7 días).',
    );
    expect(leadHoursError([1.5])).toBe(
      'Cada recordatorio debe ser de 1 a 168 horas antes (7 días).',
    );
    expect(leadHoursError([24, 24])).toBe(
      'No repitas la misma antelación: cada recordatorio sale a una hora distinta.',
    );
  });

  it('activar exige al menos una antelación; desactivar, no', () => {
    expect(settingsError({ enabled: true, leadHours: [] })).toBe(
      'Para activar los recordatorios elige al menos una antelación.',
    );
    expect(settingsError({ enabled: false, leadHours: [] })).toBeNull();
    expect(settingsError({ enabled: true, leadHours: [48, 2] })).toBeNull();
  });
});
