import {
  dueDigestWeek,
  dueInstant,
  mondayOf,
  previousFullWeek,
  weekBefore,
  weekLongLabel,
  weekShortLabel,
} from './weekly-digest-schedule';

const CARACAS = 'America/Caracas'; // UTC−4 todo el año
const NEW_YORK = 'America/New_York'; // con cambio de hora
const MONDAY_7 = { weekday: 1, hour: 7 };

describe('semana del resumen (DX-568, D3)', () => {
  it('el lunes de cualquier día de la semana (lunes a domingo)', () => {
    expect(mondayOf('2026-11-16')).toBe('2026-11-16'); // lunes
    expect(mondayOf('2026-11-18')).toBe('2026-11-16'); // miércoles
    expect(mondayOf('2026-11-22')).toBe('2026-11-16'); // domingo
  });

  it('la semana completa anterior a la de hoy, también cruzando mes y año', () => {
    expect(previousFullWeek('2026-11-17')).toEqual({
      weekStart: '2026-11-09',
      weekEnd: '2026-11-15',
    });
    expect(previousFullWeek('2027-01-04')).toEqual({
      weekStart: '2026-12-28',
      weekEnd: '2027-01-03',
    });
    expect(
      weekBefore({ weekStart: '2026-11-09', weekEnd: '2026-11-15' }),
    ).toEqual({ weekStart: '2026-11-02', weekEnd: '2026-11-08' });
  });

  describe('¿toca enviar?', () => {
    it('lunes 7:00 en la sede: antes no, a la hora sí y es la semana anterior', () => {
      // 2026-11-16 07:00 en Caracas = 11:00Z.
      expect(
        dueDigestWeek(new Date('2026-11-16T10:59:59Z'), MONDAY_7, CARACAS),
      ).toBeNull();
      expect(
        dueDigestWeek(new Date('2026-11-16T11:00:00Z'), MONDAY_7, CARACAS),
      ).toEqual({ weekStart: '2026-11-09', weekEnd: '2026-11-15' });
    });

    it('el servidor caído el lunes: sale el martes, con la MISMA semana', () => {
      expect(
        dueDigestWeek(new Date('2026-11-17T15:00:00Z'), MONDAY_7, CARACAS),
      ).toEqual({ weekStart: '2026-11-09', weekEnd: '2026-11-15' });
      // Y el domingo, último día de esa semana, todavía la misma.
      expect(
        dueDigestWeek(new Date('2026-11-23T03:00:00Z'), MONDAY_7, CARACAS),
      ).toEqual({ weekStart: '2026-11-09', weekEnd: '2026-11-15' });
    });

    it('nunca una semana de hace dos: el lunes siguiente antes de la hora no toca', () => {
      // 2026-11-23 06:00 en Caracas: la semana del 9 ya no es «la anterior»
      // y la del 16 aún no toca.
      expect(
        dueDigestWeek(new Date('2026-11-23T10:00:00Z'), MONDAY_7, CARACAS),
      ).toBeNull();
      expect(
        dueDigestWeek(new Date('2026-11-23T11:00:00Z'), MONDAY_7, CARACAS),
      ).toEqual({ weekStart: '2026-11-16', weekEnd: '2026-11-22' });
    });

    it('el domingo es el último día de la semana (0 = domingo)', () => {
      const sunday = { weekday: 0, hour: 20 };
      // Domingo 2026-11-22 20:00 en Caracas = lunes 00:00Z.
      expect(dueInstant('2026-11-17', sunday, CARACAS).toISOString()).toBe(
        '2026-11-23T00:00:00.000Z',
      );
      expect(
        dueDigestWeek(new Date('2026-11-22T23:59:00Z'), sunday, CARACAS),
      ).toBeNull();
      expect(
        dueDigestWeek(new Date('2026-11-23T00:00:00Z'), sunday, CARACAS),
      ).toEqual({ weekStart: '2026-11-09', weekEnd: '2026-11-15' });
    });

    it('la zona manda: el lunes empieza a la medianoche de la sede, no de UTC', () => {
      const midnight = { weekday: 1, hour: 0 };
      // 2026-11-16 04:00Z es el lunes 00:00 en Caracas; 03:59Z, aún domingo.
      expect(
        dueDigestWeek(new Date('2026-11-16T04:00:00Z'), midnight, CARACAS),
      ).toEqual({ weekStart: '2026-11-09', weekEnd: '2026-11-15' });
      // Un minuto antes, en Caracas sigue siendo la semana del 9: la que
      // toca (ya enviada) es la del 2.
      expect(
        dueDigestWeek(new Date('2026-11-16T03:59:00Z'), midnight, CARACAS),
      ).toEqual({ weekStart: '2026-11-02', weekEnd: '2026-11-08' });
    });

    it('cambio de hora: la hora elegida es de pared (EDT y EST)', () => {
      // Lunes 2027-03-15 tras el adelanto (EDT, UTC−4): 7:00 = 11:00Z.
      expect(dueInstant('2027-03-15', MONDAY_7, NEW_YORK).toISOString()).toBe(
        '2027-03-15T11:00:00.000Z',
      );
      // Lunes 2026-11-02 tras el atraso (EST, UTC−5): 7:00 = 12:00Z.
      expect(dueInstant('2026-11-02', MONDAY_7, NEW_YORK).toISOString()).toBe(
        '2026-11-02T12:00:00.000Z',
      );
      expect(
        dueDigestWeek(new Date('2026-11-02T11:30:00Z'), MONDAY_7, NEW_YORK),
      ).toBeNull();
      expect(
        dueDigestWeek(new Date('2026-11-02T12:00:00Z'), MONDAY_7, NEW_YORK),
      ).toEqual({ weekStart: '2026-10-26', weekEnd: '2026-11-01' });
    });
  });

  it('las etiquetas del asunto y del cuerpo', () => {
    const week = { weekStart: '2026-11-09', weekEnd: '2026-11-15' };
    expect(weekShortLabel(week)).toBe('9 nov–15 nov');
    expect(weekLongLabel(week)).toBe(
      'del lunes 9 al domingo 15 de noviembre de 2026',
    );
    expect(
      weekLongLabel({ weekStart: '2026-11-30', weekEnd: '2026-12-06' }),
    ).toBe('del lunes 30 de noviembre al domingo 6 de diciembre de 2026');
    expect(
      weekLongLabel({ weekStart: '2026-12-28', weekEnd: '2027-01-03' }),
    ).toBe('del lunes 28 de diciembre de 2026 al domingo 3 de enero de 2027');
  });
});
