import { regionalFormat } from '../../../shared/format/regional-format';
import {
  BusinessHours,
  businessHoursErrorMessage,
  describeDayRanges,
  fitsBusinessHours,
  minuteText,
  toWallClockSlot,
} from './business-hours';

// Datos de test: una sede de 24 h y otra de 12 h.
const H23 = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
const H12 = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });

// Horario típico con cierre de mediodía: lun-vie 9-13 y 15-19, sáb 9-13,
// domingo cerrado. La zona del fixture es UTC-4 fijo (sin DST), así que las cuentas de abajo
// son verificables a mano.
function caracasHours(): BusinessHours {
  const weekdays = [1, 2, 3, 4, 5];
  return {
    timezone: 'America/Caracas',
    ranges: [
      ...weekdays.flatMap((weekday) => [
        { weekday, startMinute: 9 * 60, endMinute: 13 * 60 },
        { weekday, startMinute: 15 * 60, endMinute: 19 * 60 },
      ]),
      { weekday: 6, startMinute: 9 * 60, endMinute: 13 * 60 },
    ],
  };
}

// 2026-08-03 es LUNES. En la zona de la sede (UTC-4), 13:00Z = 09:00 local.
const MONDAY_09_LOCAL = new Date('2026-08-03T13:00:00.000Z');
const MONDAY_10_LOCAL = new Date('2026-08-03T14:00:00.000Z');

describe('toWallClockSlot', () => {
  it('traslada el instante a la hora de pared de la sede (no la del servidor)', () => {
    const slot = toWallClockSlot(
      MONDAY_09_LOCAL,
      MONDAY_10_LOCAL,
      'America/Caracas',
    );

    expect(slot.weekday).toBe(1); // lunes
    expect(slot.startMinute).toBe(9 * 60);
    expect(slot.endMinute).toBe(10 * 60);
  });

  it('el MISMO instante da otra hora de pared en otra zona', () => {
    // 13:00Z son 15:00 en Madrid (CEST, UTC+2) el mismo día.
    const slot = toWallClockSlot(
      MONDAY_09_LOCAL,
      MONDAY_10_LOCAL,
      'Europe/Madrid',
    );

    expect(slot.startMinute).toBe(15 * 60);
  });

  it('una cita que cruza medianoche da endMinute > 1440 (no cabe en ningún tramo)', () => {
    const start = new Date('2026-08-04T03:30:00.000Z'); // 23:30 local (lunes)
    const end = new Date('2026-08-04T04:30:00.000Z'); // 00:30 local (martes)
    const slot = toWallClockSlot(start, end, 'America/Caracas');

    expect(slot.startMinute).toBe(23 * 60 + 30);
    expect(slot.endMinute).toBeGreaterThan(1440);
  });
});

describe('fitsBusinessHours', () => {
  it('sin horario configurado NO restringe (compatibilidad con clínicas existentes)', () => {
    const madrugada = new Date('2026-08-03T07:00:00.000Z'); // 03:00 local
    expect(
      fitsBusinessHours(
        madrugada,
        new Date(madrugada.getTime() + 1800000),
        null,
      ),
    ).toBe(true);
  });

  it('acepta una cita dentro de un tramo', () => {
    expect(
      fitsBusinessHours(MONDAY_09_LOCAL, MONDAY_10_LOCAL, caracasHours()),
    ).toBe(true);
  });

  it('acepta terminar EXACTAMENTE al cierre (comparación medio-abierta)', () => {
    const start = new Date('2026-08-03T16:30:00.000Z'); // 12:30 local
    const end = new Date('2026-08-03T17:00:00.000Z'); // 13:00 local = cierre
    expect(fitsBusinessHours(start, end, caracasHours())).toBe(true);
  });

  it('rechaza la madrugada', () => {
    const start = new Date('2026-08-03T07:00:00.000Z'); // 03:00 local
    expect(
      fitsBusinessHours(
        start,
        new Date(start.getTime() + 1800000),
        caracasHours(),
      ),
    ).toBe(false);
  });

  it('rechaza el cierre de mediodía (13:00–15:00)', () => {
    const start = new Date('2026-08-03T18:00:00.000Z'); // 14:00 local
    expect(
      fitsBusinessHours(
        start,
        new Date(start.getTime() + 1800000),
        caracasHours(),
      ),
    ).toBe(false);
  });

  it('rechaza una cita que se PASA del cierre aunque empiece dentro', () => {
    const start = new Date('2026-08-03T16:30:00.000Z'); // 12:30 local
    const end = new Date('2026-08-03T17:30:00.000Z'); // 13:30 local (cierra 13:00)
    expect(fitsBusinessHours(start, end, caracasHours())).toBe(false);
  });

  it('rechaza una cita que cruzaría el cierre de mediodía repartida en dos tramos', () => {
    const start = new Date('2026-08-03T16:00:00.000Z'); // 12:00 local
    const end = new Date('2026-08-03T20:00:00.000Z'); // 16:00 local
    // Empieza en el tramo de mañana y termina en el de tarde: NO cabe completa
    // en uno solo, así que se rechaza (habría atención durante el cierre).
    expect(fitsBusinessHours(start, end, caracasHours())).toBe(false);
  });

  it('rechaza un día cerrado (domingo)', () => {
    const start = new Date('2026-08-02T14:00:00.000Z'); // domingo 10:00 local
    expect(
      fitsBusinessHours(
        start,
        new Date(start.getTime() + 1800000),
        caracasHours(),
      ),
    ).toBe(false);
  });

  it('respeta el horario distinto del sábado (cierra 13:00, no 19:00)', () => {
    const hours = caracasHours();
    const sabadoManana = new Date('2026-08-01T14:00:00.000Z'); // sáb 10:00 local
    const sabadoTarde = new Date('2026-08-01T20:00:00.000Z'); // sáb 16:00 local

    expect(
      fitsBusinessHours(
        sabadoManana,
        new Date(sabadoManana.getTime() + 1800000),
        hours,
      ),
    ).toBe(true);
    expect(
      fitsBusinessHours(
        sabadoTarde,
        new Date(sabadoTarde.getTime() + 1800000),
        hours,
      ),
    ).toBe(false);
  });
});

describe('mensajes', () => {
  it('describe los tramos del día', () => {
    expect(describeDayRanges(1, caracasHours(), H23)).toBe(
      '09:00–13:00, 15:00–19:00',
    );
  });

  it('describe los tramos del día en 12 h con una sede h12', () => {
    expect(describeDayRanges(1, caracasHours(), H12)).toBe(
      '9:00 a. m.–1:00 p. m., 3:00 p. m.–7:00 p. m.',
    );
  });

  it('un tramo que llega a medianoche: 24:00 en 24 h, 12:00 a. m. en 12 h', () => {
    expect(minuteText(1440, H23)).toBe('24:00');
    expect(minuteText(1440, H12)).toBe('12:00 a. m.');
    expect(minuteText(0, H23)).toBe('00:00');
    expect(minuteText(13 * 60 + 5, H12)).toBe('1:05 p. m.');
  });

  it('el error dice el horario real del día cuando el día abre (h23 de-DE)', () => {
    const start = new Date('2026-08-03T18:00:00.000Z'); // lunes 14:00 local
    expect(
      businessHoursErrorMessage(
        start,
        new Date(start.getTime() + 1800000),
        caracasHours(),
        () => H23,
      ),
    ).toBe('Fuera del horario de atención (lunes: 09:00–13:00, 15:00–19:00)');
  });

  it('el error dice el horario real del día en 12 h (h12 en-US)', () => {
    const start = new Date('2026-08-03T18:00:00.000Z'); // lunes 14:00 local
    expect(
      businessHoursErrorMessage(
        start,
        new Date(start.getTime() + 1800000),
        caracasHours(),
        () => H12,
      ),
    ).toBe(
      'Fuera del horario de atención (lunes: 9:00 a. m.–1:00 p. m., 3:00 p. m.–7:00 p. m.)',
    );
  });

  it('el error dice que no se atiende cuando el día está cerrado, sin pedir el formato', () => {
    const start = new Date('2026-08-02T14:00:00.000Z'); // domingo
    const fmt = jest.fn(() => H23);
    expect(
      businessHoursErrorMessage(
        start,
        new Date(start.getTime() + 1800000),
        caracasHours(),
        fmt,
      ),
    ).toBe('La sede no atiende los domingos');
    expect(fmt).not.toHaveBeenCalled();
  });

  it('pluraliza solo los días que lo necesitan (sábado sí, martes no)', () => {
    // Solo se abre lunes: cualquier otro día cae en la rama de "cerrado".
    const soloLunes = {
      timezone: 'America/Caracas',
      ranges: [{ weekday: 1, startMinute: 540, endMinute: 1080 }],
    };
    const sabado = new Date('2026-08-08T14:00:00.000Z');
    const martes = new Date('2026-08-04T14:00:00.000Z');
    expect(
      businessHoursErrorMessage(
        sabado,
        new Date(sabado.getTime() + 1800000),
        soloLunes,
        () => H23,
      ),
    ).toBe('La sede no atiende los sábados');
    expect(
      businessHoursErrorMessage(
        martes,
        new Date(martes.getTime() + 1800000),
        soloLunes,
        () => H23,
      ),
    ).toBe('La sede no atiende los martes');
  });
});
