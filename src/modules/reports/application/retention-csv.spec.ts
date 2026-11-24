import { retentionDefinitions } from '../domain/retention';
import { toRetentionCsv, toRetentionPatientsCsv } from './retention-csv';
import type {
  RetentionPatientsReport,
  RetentionReport,
} from './use-cases/get-retention.use-case';

const filters = {
  locationId: null,
  locationName: null,
  providerId: null,
  providerName: null,
  activeMonths: 18 as const,
};
const figures = {
  activeAtStart: 10,
  newPatients: 3,
  lost: 2,
  activeAtEnd: 11,
  reactivated: 0,
  newNoReturn: 1,
  retentionRate: 80,
};

describe('CSV de «Retención» (DX-260)', () => {
  it('el informe: filas por sede y profesional, subtotal de sede y total; definiciones en la cabecera', () => {
    const report: RetentionReport = {
      from: '2026-01-01',
      to: '2026-06-30',
      filters,
      options: { locations: [], professionals: [] },
      rows: [
        {
          ...figures,
          locationId: 'l1',
          locationName: 'Sede Chacao',
          providerId: 'u1',
          providerName: '=Dra. Pérez',
        },
      ],
      locations: [
        { ...figures, locationId: 'l1', locationName: 'Sede Chacao' },
      ],
      totals: { ...figures, retentionRate: null },
      definitions: retentionDefinitions(18),
      hasData: true,
    };
    const csv = toRetentionCsv(report);
    expect(csv.startsWith('﻿"Retención de pacientes"\r\n')).toBe(true);
    expect(csv).toContain('"Período","2026-01-01 a 2026-06-30"');
    expect(csv).toContain('"Activo si vino en los últimos","18 meses"');
    expect(csv).toContain('"Perdidos","Activos al inicio que no tienen');
    // Nombre protegido contra fórmulas.
    expect(csv).toContain(`"Sede Chacao","'=Dra. Pérez",10,3,2,11,0,80,1`);
    expect(csv).toContain('"Sede Chacao","Total sede",10,3,2,11,0,80,1');
    // Retención sin base: celda vacía.
    expect(csv).toContain('"Total","",10,3,2,11,0,,1\r\n');
  });

  it('una lista: contacto, baja de avisos, días en la zona de la sede y aviso si se recortó', () => {
    const report: RetentionPatientsReport = {
      from: '2026-01-01',
      to: '2026-06-30',
      segment: 'lost',
      filters: { ...filters, locationName: 'Sede Chacao' },
      definition: retentionDefinitions(18).find((d) => d.segment === 'lost')!,
      items: [
        {
          patientId: 'p1',
          patientName: 'Ana Rondón',
          // Con baja de avisos el caso de uso ya lo deja en null.
          phone: null,
          whatsApp: null,
          reminderOptedOut: true,
          firstVisitAt: new Date('2024-01-02T14:00:00Z'),
          // 23:00 del 4/11 en Caracas (03:00 UTC del 5/11).
          lastVisitAt: new Date('2024-11-05T03:00:00Z'),
          locationId: 'l1',
          locationName: 'Sede Chacao',
          providerId: 'u1',
          providerName: 'Dra. Pérez',
          hasUpcomingAppointment: false,
          timeZone: 'America/Caracas',
        },
      ],
      total: 2,
      page: 1,
      pageSize: 1,
      truncated: true,
    };
    const csv = toRetentionPatientsCsv(report);
    expect(csv).toContain('"Retención de pacientes: Perdidos"');
    expect(csv).toContain('"Sede","Sede Chacao"');
    expect(csv).toContain('"Pacientes",2');
    expect(csv).toContain('"Aviso","Solo las 1 primeras filas de 2."');
    expect(csv).toContain(
      `"Ana Rondón","","Sí","2024-01-02","2024-11-04","Sede Chacao","Dra. Pérez","No"`,
    );
  });
});
