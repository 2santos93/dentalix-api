import { regionalFormat } from '../../../shared/format/regional-format';
import {
  crossLocationConflictOn,
  crossLocationMessage,
  describeRange,
  rangeShapeError,
  intersectRanges,
  overrideRangesError,
  providerDayAssignments,
  providerRangesOn,
  providerWorksAt,
  weeklyScheduleError,
  type ProviderScheduleSnapshot,
} from './provider-availability';

const A = 'sede-a';
const B = 'sede-b';
const CARACAS = 'America/Caracas';
const MADRID = 'Europe/Madrid';
const H = (h: number, m = 0) => h * 60 + m;
// Datos de test: una sede de 24 h y otra de 12 h.
const H23 = regionalFormat({ locale: 'de-DE', hourCycle: 'h23' });
const H12 = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });

/** Dra. X: lunes y miércoles 8–13 en A, jueves 14–19 en B. */
function draX(
  overrides: ProviderScheduleSnapshot['overrides'] = [],
): ProviderScheduleSnapshot {
  return {
    providerId: 'dra-x',
    configured: true,
    weekly: [
      { locationId: A, weekday: 1, startMinute: H(8), endMinute: H(13) },
      { locationId: A, weekday: 3, startMinute: H(8), endMinute: H(13) },
      { locationId: B, weekday: 4, startMinute: H(14), endMinute: H(19) },
    ],
    overrides,
  };
}

const UNCONFIGURED: ProviderScheduleSnapshot = {
  providerId: 'dr-y',
  configured: false,
  weekly: [],
  overrides: [],
};

const names = (id: string) => (id === A ? 'Sede A' : 'Sede B');

describe('providerWorksAt (DX-233)', () => {
  // 2026-10-19 es lunes; 2026-10-22, jueves. La zona del fixture es UTC−4 fijo.
  it('sin horario configurado no restringe (compatibilidad)', () => {
    expect(
      providerWorksAt(
        UNCONFIGURED,
        A,
        new Date('2026-10-19T07:00:00Z'), // 03:00 en la zona de la sede
        new Date('2026-10-19T07:30:00Z'),
        CARACAS,
      ),
    ).toBe(true);
  });

  it('con horario, la cita tiene que caber completa en un tramo de ESA sede', () => {
    const s = draX();
    // Lunes 8:00–8:30 en A: sí.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-19T12:00:00Z'),
        new Date('2026-10-19T12:30:00Z'),
        CARACAS,
      ),
    ).toBe(true);
    // Lunes 12:45–13:15 en A: se sale del tramo.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-19T16:45:00Z'),
        new Date('2026-10-19T17:15:00Z'),
        CARACAS,
      ),
    ).toBe(false);
    // Termina justo a las 13:00: medio abierto, vale.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-19T16:30:00Z'),
        new Date('2026-10-19T17:00:00Z'),
        CARACAS,
      ),
    ).toBe(true);
    // Lunes en B: ese día no trabaja allí.
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-19T12:00:00Z'),
        new Date('2026-10-19T12:30:00Z'),
        CARACAS,
      ),
    ).toBe(false);
    // Jueves 14:00 en B: sí.
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-22T18:00:00Z'),
        new Date('2026-10-22T19:00:00Z'),
        CARACAS,
      ),
    ).toBe(true);
    // Una sede donde no tiene horario: no trabaja allí.
    expect(
      providerWorksAt(
        s,
        'sede-c',
        new Date('2026-10-22T18:00:00Z'),
        new Date('2026-10-22T19:00:00Z'),
        CARACAS,
      ),
    ).toBe(false);
  });

  it('la excepción «no trabaja» prevalece sobre el semanal ese día', () => {
    const s = draX([
      { id: 'o1', locationId: B, date: '2026-10-22', ranges: [], note: null },
    ]);
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-22T18:00:00Z'),
        new Date('2026-10-22T19:00:00Z'),
        CARACAS,
      ),
    ).toBe(false);
    // La semana siguiente vuelve el semanal.
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-29T18:00:00Z'),
        new Date('2026-10-29T19:00:00Z'),
        CARACAS,
      ),
    ).toBe(true);
  });

  it('la excepción con otro horario prevalece y manda sus tramos', () => {
    const s = draX([
      {
        id: 'o1',
        locationId: B,
        date: '2026-10-22',
        ranges: [{ startMinute: H(9), endMinute: H(12) }],
        note: null,
      },
    ]);
    // 9:00 sí (excepción), 14:00 ya no (el semanal no aplica ese día).
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-22T13:00:00Z'),
        new Date('2026-10-22T14:00:00Z'),
        CARACAS,
      ),
    ).toBe(true);
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-22T18:00:00Z'),
        new Date('2026-10-22T19:00:00Z'),
        CARACAS,
      ),
    ).toBe(false);
  });

  it('una excepción restringe ese día aunque el profesional no tenga horario semanal', () => {
    const s: ProviderScheduleSnapshot = {
      ...UNCONFIGURED,
      overrides: [
        { id: 'o', locationId: A, date: '2026-10-19', ranges: [], note: null },
      ],
    };
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-19T12:00:00Z'),
        new Date('2026-10-19T12:30:00Z'),
        CARACAS,
      ),
    ).toBe(false);
    // Otra sede, o el día siguiente: sin restricción.
    expect(
      providerWorksAt(
        s,
        B,
        new Date('2026-10-19T12:00:00Z'),
        new Date('2026-10-19T12:30:00Z'),
        CARACAS,
      ),
    ).toBe(true);
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-20T12:00:00Z'),
        new Date('2026-10-20T12:30:00Z'),
        CARACAS,
      ),
    ).toBe(true);
  });

  it('una cita que cruza medianoche no cabe aunque el tramo llegue a las 24:00', () => {
    const s: ProviderScheduleSnapshot = {
      providerId: 'p',
      configured: true,
      weekly: [
        { locationId: A, weekday: 1, startMinute: H(20), endMinute: 1440 },
        { locationId: A, weekday: 2, startMinute: 0, endMinute: H(4) },
      ],
      overrides: [],
    };
    // Lunes 23:30 → martes 00:30 en la zona de la sede.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-20T03:30:00Z'),
        new Date('2026-10-20T04:30:00Z'),
        CARACAS,
      ),
    ).toBe(false);
    // Hasta las 24:00 justas, sí.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-20T03:30:00Z'),
        new Date('2026-10-20T04:00:00Z'),
        CARACAS,
      ),
    ).toBe(true);
  });

  it('España: las 9:00 de pared el día del cambio de hora y el anterior', () => {
    // Sábado 24 y domingo 25 de octubre de 2026, 9:00–13:00 en Madrid. El 25
    // a las 03:00 CEST vuelve a las 02:00 CET (UTC+2 → UTC+1).
    const s: ProviderScheduleSnapshot = {
      providerId: 'p',
      configured: true,
      weekly: [
        { locationId: A, weekday: 6, startMinute: H(9), endMinute: H(13) },
        { locationId: A, weekday: 0, startMinute: H(9), endMinute: H(13) },
      ],
      overrides: [],
    };
    // Sábado (CEST): 9:00 = 07:00Z.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-24T07:00:00Z'),
        new Date('2026-10-24T08:00:00Z'),
        MADRID,
      ),
    ).toBe(true);
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-24T06:30:00Z'),
        new Date('2026-10-24T07:30:00Z'),
        MADRID,
      ),
    ).toBe(false);
    // Domingo (CET): 9:00 = 08:00Z; las 07:00Z son las 8:00 de pared.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-25T08:00:00Z'),
        new Date('2026-10-25T09:00:00Z'),
        MADRID,
      ),
    ).toBe(true);
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-25T07:00:00Z'),
        new Date('2026-10-25T08:00:00Z'),
        MADRID,
      ),
    ).toBe(false);
    // 12:00–13:00 de pared el domingo = 11:00Z–12:00Z.
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-25T11:00:00Z'),
        new Date('2026-10-25T12:00:00Z'),
        MADRID,
      ),
    ).toBe(true);
  });

  it('zona sin cambio de hora: el día lo marca la zona de la sede', () => {
    // Lunes 19 a las 20:00 en la zona de la sede ya es martes 00:00Z.
    const s: ProviderScheduleSnapshot = {
      providerId: 'p',
      configured: true,
      weekly: [
        { locationId: A, weekday: 1, startMinute: H(18), endMinute: H(21) },
      ],
      overrides: [],
    };
    expect(
      providerWorksAt(
        s,
        A,
        new Date('2026-10-20T00:00:00Z'),
        new Date('2026-10-20T00:30:00Z'),
        CARACAS,
      ),
    ).toBe(true);
  });
});

describe('providerRangesOn / providerDayAssignments', () => {
  it('sin horario devuelve null (sin restricción)', () => {
    expect(providerRangesOn(UNCONFIGURED, A, '2026-10-19')).toBeNull();
  });

  it('el cuadrante del día: sedes con sus tramos y la excepción «no trabaja»', () => {
    const s = draX([
      { id: 'o1', locationId: B, date: '2026-10-22', ranges: [], note: null },
    ]);
    expect(providerDayAssignments(s, '2026-10-19')).toEqual([
      {
        locationId: A,
        source: 'WEEKLY',
        overrideId: null,
        ranges: [{ startMinute: H(8), endMinute: H(13) }],
      },
    ]);
    expect(providerDayAssignments(s, '2026-10-22')).toEqual([
      { locationId: B, source: 'OVERRIDE', overrideId: 'o1', ranges: [] },
    ]);
    expect(providerDayAssignments(s, '2026-10-20')).toEqual([]);
  });
});

describe('intersectRanges', () => {
  it('cruza los tramos de la sede con los del profesional', () => {
    expect(
      intersectRanges(
        [
          { startMinute: H(9), endMinute: H(13) },
          { startMinute: H(15), endMinute: H(19) },
        ],
        [{ startMinute: H(8), endMinute: H(16) }],
      ),
    ).toEqual([
      { startMinute: H(9), endMinute: H(13) },
      { startMinute: H(15), endMinute: H(16) },
    ]);
    expect(
      intersectRanges(
        [{ startMinute: H(9), endMinute: H(13) }],
        [{ startMinute: H(13), endMinute: H(16) }],
      ),
    ).toEqual([]);
  });
});

describe('weeklyScheduleError', () => {
  const ok = [
    {
      locationId: A,
      ranges: [
        { weekday: 1, startMinute: H(8), endMinute: H(13) },
        { weekday: 3, startMinute: H(8), endMinute: H(13) },
      ],
    },
    {
      locationId: B,
      ranges: [{ weekday: 4, startMinute: H(14), endMinute: H(19) }],
    },
  ];

  it('acepta la rotación de la Dra. X', () => {
    expect(weeklyScheduleError(ok, names, () => H23)).toBeNull();
  });

  it('rechaza un solape del mismo día en dos sedes, en español', () => {
    expect(
      weeklyScheduleError(
        [
          ok[0],
          {
            locationId: B,
            ranges: [{ weekday: 1, startMinute: H(12), endMinute: H(15) }],
          },
        ],
        names,
        () => H23,
      ),
    ).toBe(
      'El tramo 08:00–13:00 en Sede A se solapa el lunes con 12:00–15:00 en Sede B: un profesional no puede estar en dos sedes a la vez.',
    );
  });

  it('contiguo entre sedes vale (13:00 en A y 13:00 en B)', () => {
    expect(
      weeklyScheduleError(
        [
          ok[0],
          {
            locationId: B,
            ranges: [{ weekday: 1, startMinute: H(13), endMinute: H(15) }],
          },
        ],
        names,
        () => H23,
      ),
    ).toBeNull();
  });

  it.each([
    [
      'minutos no múltiplos de 5',
      [{ weekday: 1, startMinute: H(8, 2), endMinute: H(13) }],
      /de 5 en 5 minutos/,
    ],
    [
      'fin antes del inicio',
      [{ weekday: 1, startMinute: H(13), endMinute: H(8) }],
      /posterior a su inicio/,
    ],
    [
      'más allá de las 24:00',
      [{ weekday: 1, startMinute: H(22), endMinute: 1445 }],
      /entre 0 \(00:00\) y 1440/,
    ],
    [
      'día 7',
      [{ weekday: 7, startMinute: H(8), endMinute: H(9) }],
      /de 0 \(domingo\) a 6/,
    ],
    [
      'solape en la misma sede',
      [
        { weekday: 2, startMinute: H(8), endMinute: H(10) },
        { weekday: 2, startMinute: H(9), endMinute: H(11) },
      ],
      /solapados el martes en Sede A/,
    ],
    [
      'más de 7 tramos un día',
      Array.from({ length: 8 }, (_, i) => ({
        weekday: 5,
        startMinute: H(8 + i),
        endMinute: H(8 + i, 30),
      })),
      /Como mucho 7 tramos por día y sede \(viernes en Sede A\)/,
    ],
  ])('rechaza %s', (_label, ranges, message) => {
    expect(
      weeklyScheduleError([{ locationId: A, ranges }], names, () => H23),
    ).toMatch(message);
  });

  it('rechaza la misma sede dos veces', () => {
    expect(weeklyScheduleError([ok[0], ok[0]], names, () => H23)).toMatch(
      /viene dos veces/,
    );
  });
});

describe('overrideRangesError y crossLocationConflictOn', () => {
  it('«no trabaja» (sin tramos) es válido; el resto, con las reglas del semanal', () => {
    expect(overrideRangesError([], () => H23)).toBeNull();
    expect(
      overrideRangesError(
        [{ startMinute: H(9), endMinute: H(9, 7) }],
        () => H23,
      ),
    ).toMatch(/de 5 en 5/);
    expect(
      overrideRangesError(
        [
          { startMinute: H(9), endMinute: H(11) },
          { startMinute: H(10), endMinute: H(12) },
        ],
        () => H23,
      ),
    ).toMatch(/solapados/);
  });

  it('una excepción en A que pisa el semanal de B ese día es un conflicto', () => {
    const s = draX();
    expect(
      crossLocationConflictOn(s, A, '2026-10-22', [
        { startMinute: H(15), endMinute: H(17) },
      ]),
    ).toEqual({
      otherLocationId: B,
      mine: { startMinute: H(15), endMinute: H(17) },
      theirs: { startMinute: H(14), endMinute: H(19) },
    });
    // Si en B ese día tiene «no trabaja», ya no.
    const off = draX([
      { id: 'o', locationId: B, date: '2026-10-22', ranges: [], note: null },
    ]);
    expect(
      crossLocationConflictOn(off, A, '2026-10-22', [
        { startMinute: H(15), endMinute: H(17) },
      ]),
    ).toBeNull();
  });
});

describe('horas de los mensajes con el reloj de la sede (DX-354)', () => {
  it('describeRange: 24 h con h23 y 12 h con h12; la medianoche final es 24:00 / medianoche', () => {
    const r = { startMinute: H(9), endMinute: H(13) };
    expect(describeRange(r, H23)).toBe('09:00–13:00');
    expect(describeRange(r, H12)).toBe('9:00 a. m.–1:00 p. m.');
    const night = { startMinute: H(21), endMinute: 1440 };
    expect(describeRange(night, H23)).toBe('21:00–24:00');
    expect(describeRange(night, H12)).toBe('9:00 p. m.–medianoche');
  });

  it('rangeShapeError con h12 escribe 0 y 1440 con el reloj de la sede', () => {
    expect(rangeShapeError({ startMinute: -5, endMinute: 60 }, () => H12)).toBe(
      'Los minutos de un tramo tienen que ser enteros entre 0 (12:00 a. m.) y 1440 (medianoche).',
    );
    expect(rangeShapeError({ startMinute: -5, endMinute: 60 }, () => H23)).toBe(
      'Los minutos de un tramo tienen que ser enteros entre 0 (00:00) y 1440 (24:00).',
    );
    expect(
      rangeShapeError({ startMinute: H(9, 7), endMinute: H(10) }, () => H12),
    ).toBe(
      'Las horas de un tramo van de 5 en 5 minutos (9:07 a. m.–10:00 a. m.).',
    );
  });

  it('rangeShapeError no pide el formato si el tramo está bien', () => {
    const fmt = jest.fn(() => H23);
    expect(
      rangeShapeError({ startMinute: H(9), endMinute: H(10) }, fmt),
    ).toBeNull();
    expect(fmt).not.toHaveBeenCalled();
  });

  it('crossLocationMessage usa un solo reloj para toda la frase', () => {
    const message = crossLocationMessage(
      'el lunes',
      { name: 'Sede A', range: { startMinute: H(8), endMinute: H(13) } },
      { name: 'Sede B', range: { startMinute: H(12), endMinute: H(15) } },
      H12,
    );
    expect(message).toBe(
      'El tramo 8:00 a. m.–1:00 p. m. en Sede A se solapa el lunes con 12:00 p. m.–3:00 p. m. en Sede B: un profesional no puede estar en dos sedes a la vez.',
    );
  });
});
