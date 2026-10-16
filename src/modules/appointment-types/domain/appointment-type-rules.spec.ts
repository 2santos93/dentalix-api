import {
  APPOINTMENT_TYPE_COLOR,
  appointmentTypeColorError,
  appointmentTypeDurationError,
  appointmentTypeNameError,
  endFromDuration,
  normalizeAppointmentTypeColor,
} from './appointment-type-rules';

describe('reglas de tipos de cita (DX-121)', () => {
  describe('color', () => {
    it.each(['#7C3AED', '#0e7490', '#000000', '#FFFFFF'])(
      'acepta %s',
      (color) => {
        expect(appointmentTypeColorError(color)).toBeNull();
        expect(APPOINTMENT_TYPE_COLOR.test(color)).toBe(true);
      },
    );

    it.each([
      '7C3AED',
      '#FFF',
      '#7C3AED80',
      'red',
      'url(javascript:alert(1))',
      '#7C3AED; background: url(x)',
      '#GGGGGG',
      ' #7C3AED',
    ])('rechaza %j (nunca CSS libre)', (color) => {
      expect(appointmentTypeColorError(color)).toMatch(/#RRGGBB/);
    });

    it('normaliza a mayúsculas', () => {
      expect(normalizeAppointmentTypeColor('#7c3aed')).toBe('#7C3AED');
    });
  });

  describe('duración', () => {
    it.each([5, 30, 90, 480])('acepta %i minutos', (minutes) => {
      expect(appointmentTypeDurationError(minutes)).toBeNull();
    });

    it.each([0, 4, 7, 481, 500, 30.5, -5, Number.NaN])(
      'rechaza %p minutos',
      (minutes) => {
        expect(appointmentTypeDurationError(minutes)).toMatch(/múltiplo de 5/);
      },
    );
  });

  describe('nombre', () => {
    it('rechaza vacío y más de 60 caracteres', () => {
      expect(appointmentTypeNameError('   ')).toMatch(/vacío/);
      expect(appointmentTypeNameError('x'.repeat(61))).toMatch(/60/);
      expect(appointmentTypeNameError('Endodoncia')).toBeNull();
    });
  });

  it('la hora de fin sale de la duración del tipo', () => {
    const start = new Date('2031-03-03T14:00:00.000Z');
    expect(endFromDuration(start, 90).toISOString()).toBe(
      '2031-03-03T15:30:00.000Z',
    );
  });
});
