import {
  EMPTY_TIMING_AGGREGATE,
  TIMING_SCOPE_NOTE,
  TIMING_THRESHOLDS,
  timingDefinitions,
  timingFigures,
} from '../domain/timing';
import { toTimingCsv } from './timing-csv';
import type { TimingReport } from './use-cases/get-timing.use-case';

// DX-275: el CSV lleva las mismas tablas que la pantalla, con la cabecera de
// filtros y definiciones, y protege los nombres que escribe la clínica.

const figures = timingFigures({
  ...EMPTY_TIMING_AGGREGATE,
  completed: 4,
  measured: 3,
  withoutTimes: 1,
  waitAvg: 7.25,
  waitP90: 12,
  startDelayAvg: -2,
  startDelayP90: 5,
  durationAvg: 33,
  durationP90: 40,
  plannedAvg: 30,
});

const occupancy = {
  availableMinutes: 1200,
  bookedMinutes: 900,
  attendedMinutes: 600,
  noShowMinutes: 60,
  freeMinutes: 300,
  occupancyPercent: 50,
};

const report: TimingReport = {
  from: '2026-03-02',
  to: '2026-03-08',
  scope: 'CLINIC',
  filters: {
    locationId: 'sede-1',
    locationName: 'Sede Chacao',
    providerId: null,
    providerName: null,
  },
  options: { locations: [], professionals: [] },
  totals: figures,
  byProfessional: [
    { providerId: 'p1', providerName: '=HYPERLINK("x")', ...figures },
  ],
  byAppointmentType: [
    {
      appointmentTypeId: 't1',
      appointmentTypeName: 'Limpieza',
      catalogDurationMinutes: 30,
      exceedsPlanned: false,
      ...figures,
    },
  ],
  byWeek: [
    {
      weekStart: '2026-03-02',
      from: '2026-03-02',
      to: '2026-03-08',
      ...figures,
    },
  ],
  occupancy: {
    professionals: [
      {
        providerId: 'p1',
        providerName: 'Dra. Pérez',
        hasSchedule: true,
        ...occupancy,
        weeks: [
          {
            weekStart: '2026-03-02',
            from: '2026-03-02',
            to: '2026-03-08',
            ...occupancy,
          },
        ],
      },
    ],
    totals: occupancy,
  },
  thresholds: TIMING_THRESHOLDS,
  scopeNote: TIMING_SCOPE_NOTE,
  definitions: timingDefinitions(),
  hasData: true,
};

describe('toTimingCsv (DX-275)', () => {
  const csv = toTimingCsv(report);
  const lines = csv.replace(/^\uFEFF/, '').split('\r\n');

  it('cabecera con período, sede, profesional, alcance y definiciones', () => {
    expect(lines[0]).toBe('"Tiempos de la agenda"');
    expect(lines[1]).toBe('"Período","2026-03-02 a 2026-03-08"');
    expect(lines[2]).toBe('"Sede","Sede Chacao"');
    expect(lines[3]).toBe('"Profesional","Todos"');
    expect(csv).toContain(
      '"Citas sin tiempos","Citas atendidas a las que les falta',
    );
  });

  it('las cinco tablas, con cifras en minutos (punto decimal) y vacío para null', () => {
    for (const title of [
      '"Por profesional"',
      '"Por tipo de cita"',
      '"Por semana"',
      '"Ocupación por profesional"',
      '"Ocupación por semana"',
    ]) {
      expect(lines).toContain(title);
    }
    expect(csv).toContain('"Total",4,3,1,0,7.3,12,-2,5,33,40,30,10');
    expect(csv).toContain('"Limpieza",30,4,3,1,0,7.3,12,-2,5,33,40,30,10,"No"');
    expect(csv).toContain('"Dra. Pérez","Sí",1200,900,600,60,300,50');
    expect(csv).toContain(
      '"Dra. Pérez","2026-03-02","2026-03-02","2026-03-08",1200,900,600,60,300,50',
    );
  });

  it('protege las celdas contra fórmulas', () => {
    expect(csv).not.toContain('"=HYPERLINK');
    expect(csv).toContain(`"'=HYPERLINK(""x"")"`);
  });
});
