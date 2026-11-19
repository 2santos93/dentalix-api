import { KPI_DEFINITIONS } from '../domain/kpi-definitions';
import {
  toNoShowsCsv,
  toProfessionalProductivityCsv,
} from './professional-reports-csv';
import type { ProfessionalProductivity } from './use-cases/get-professional-productivity.use-case';
import type { NoShowsReport } from './use-cases/get-no-shows.use-case';

const filters = {
  locationId: null,
  locationName: null,
  professionalId: null,
  professionalName: null,
};
const options = { locations: [], professionals: [] };

describe('CSV de «Profesionales» (DX-304)', () => {
  const report: ProfessionalProductivity = {
    from: '2026-11-01',
    to: '2026-11-30',
    scope: 'CLINIC',
    filters,
    options,
    rows: [
      {
        professionalId: 'a',
        fullName: '=HYPERLINK("x")',
        production: [
          { currency: 'USD', count: 2, net: 80 },
          { currency: 'VES', count: 1, net: 365.5 },
        ],
        collected: [{ currency: 'USD', amount: 50 }],
        completedAppointments: 3,
        noShows: 1,
        lateCancellations: 0,
        noShowRate: 25,
      },
    ],
    totals: {
      production: [
        { currency: 'USD', count: 2, net: 80 },
        { currency: 'VES', count: 1, net: 365.5 },
      ],
      collected: [{ currency: 'USD', amount: 50 }],
      completedAppointments: 3,
      noShows: 1,
      lateCancellations: 0,
      noShowRate: 25,
    },
    definitions: [],
    hasActivity: true,
  };

  it('BOM, filtros en la cabecera y una línea por moneda; las citas solo en la primera', () => {
    const csv = toProfessionalProductivityCsv(report);
    expect(csv.startsWith('﻿"Productividad por profesional"\r\n')).toBe(true);
    const lines = csv.split('\r\n');
    expect(lines).toContain('"Período","2026-11-01 a 2026-11-30"');
    expect(lines).toContain('"Sede","Todas tus sedes"');
    expect(lines).toContain('"Profesional","Todo el equipo"');
    expect(lines).toContain(
      `"Profesional","'=HYPERLINK(""x"")","USD",2,80.00,50.00,3,1,0,25.00`,
    );
    expect(lines).toContain(
      `"Profesional","'=HYPERLINK(""x"")","VES",1,365.50,0.00,,,,`,
    );
    expect(lines).toContain('"Total","","USD",2,80.00,50.00,3,1,0,25.00');
  });

  it('en OWN no hay línea de total', () => {
    const csv = toProfessionalProductivityCsv({
      ...report,
      scope: 'OWN',
      filters: { ...filters, professionalId: 'a', professionalName: 'Ana' },
    });
    expect(csv).toContain('"Profesional","Solo lo tuyo (Ana)"');
    expect(csv).not.toContain('"Total"');
  });
});

describe('CSV de «Inasistencias» (DX-304)', () => {
  const report: NoShowsReport = {
    from: '2026-11-01',
    to: '2026-11-30',
    scope: 'CLINIC',
    filters: { ...filters, locationId: 's', locationName: 'Sede Chacao' },
    options,
    summary: {
      completedAppointments: 8,
      noShows: 1,
      lateCancellations: 1,
      noShowRate: 10,
    },
    definition: KPI_DEFINITIONS.noShowRate,
    items: [
      {
        appointmentId: 'x',
        // 14:30 en Caracas (UTC−4).
        start: new Date('2026-11-10T18:30:00Z'),
        end: new Date('2026-11-10T19:00:00Z'),
        status: 'CANCELLED',
        kind: 'LATE_CANCELLATION',
        cancelReasonCode: 'TRANSPORT',
        noticeMinutes: 90,
        patientId: 'p',
        patientName: '@María Pérez',
        patientArchived: false,
        appointmentTypeName: 'Limpieza',
        professionalId: 'a',
        professionalName: 'Ana Rondón',
        locationId: 's',
        locationName: 'Sede Chacao',
        timeZone: 'America/Caracas',
      },
    ],
    total: 1,
    page: 1,
    pageSize: 10000,
    truncated: false,
  };

  it('resumen, fecha y hora en la zona de la sede y nombres protegidos', () => {
    const lines = toNoShowsCsv(report).split('\r\n');
    expect(lines).toContain('"Sede","Sede Chacao"');
    expect(lines).toContain('"No-show %",10.00');
    expect(lines).toContain(
      `"2026-11-10","14:30","Cancelación tardía","'@María Pérez","Ana Rondón","Sede Chacao","Limpieza","Transporte",1.5`,
    );
    expect(lines.some((l) => l.startsWith('"Aviso"'))).toBe(false);
  });

  it('si pasa del tope, lo avisa', () => {
    const csv = toNoShowsCsv({ ...report, total: 20000, truncated: true });
    expect(csv).toContain('"Aviso","Solo las 1 citas más recientes de 20000');
  });
});
