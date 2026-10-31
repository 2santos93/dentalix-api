import { regionalFormat } from '../../../shared/format/regional-format';
import {
  buildContingencyAgenda,
  contingencyWindow,
  type ContingencyAppointment,
  type ContingencySource,
} from './contingency-agenda';

const ZONE = 'America/Caracas'; // UTC−4 todo el año

function appt(
  over: Partial<Omit<ContingencyAppointment, 'start'>> & { start: string },
): ContingencyAppointment {
  const start = new Date(over.start);
  return {
    appointmentId: over.appointmentId ?? `id-${over.start}`,
    status: 'SCHEDULED',
    patientName: 'Laura Castro',
    phone: '+58 412-1234567',
    professionalName: 'Dra. Ana Gómez',
    appointmentTypeName: 'Limpieza',
    firstVisit: false,
    medicalAlert: false,
    callbackRequested: false,
    ...over,
    start,
    end: over.end ?? new Date(start.getTime() + 30 * 60_000),
  };
}

function source(over: Partial<ContingencySource> = {}): ContingencySource {
  return {
    clinicName: 'Clínica Demo',
    locationName: 'Sede Centro',
    locationPhone: '+58 212-5550000',
    timeZone: ZONE,
    fmt: regionalFormat({ locale: 'es-VE', hourCycle: 'h12' }),
    today: '2026-11-02',
    generatedAt: new Date('2026-11-02T06:15:00Z'),
    appointments: [],
    ...over,
  };
}

describe('contingencyWindow (DX-339)', () => {
  it('cubre hoy y mañana enteros en la zona de la sede, semiabierto', () => {
    const w = contingencyWindow(new Date('2026-11-02T03:30:00Z'), ZONE);
    // 03:30 UTC = 23:30 del 1 en Caracas: «hoy» es el 1.
    expect(w.days).toEqual(['2026-11-01', '2026-11-02']);
    expect(w.from.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-03T04:00:00.000Z');
  });

  it('respeta un cambio de hora (día de 25 h en Nueva York)', () => {
    const w = contingencyWindow(
      new Date('2026-11-01T12:00:00Z'),
      'America/New_York',
    );
    expect(w.days).toEqual(['2026-11-01', '2026-11-02']);
    expect(w.from.toISOString()).toBe('2026-11-01T04:00:00.000Z');
    expect(w.to.toISOString()).toBe('2026-11-03T05:00:00.000Z');
  });
});

describe('buildContingencyAgenda (DX-339)', () => {
  it('agrupa por día (hoy y mañana) con la hora en la zona y el formato de la sede', () => {
    const model = buildContingencyAgenda(
      source({
        appointments: [
          appt({ start: '2026-11-03T13:00:00Z', patientName: 'Pedro Ruiz' }),
          appt({ start: '2026-11-02T12:30:00Z' }),
        ],
      }),
    );
    expect(model.days.map((d) => d.title)).toEqual([
      'Hoy · lunes 2 de noviembre de 2026',
      'Mañana · martes 3 de noviembre de 2026',
    ]);
    expect(model.days[0].rows).toEqual([
      {
        time: '8:30 a. m. – 9:00 a. m.',
        patient: 'Laura Castro',
        phone: '+58 412-1234567',
        professional: 'Dra. Ana Gómez',
        type: 'Limpieza',
        alerts: 'Sin confirmar',
      },
    ]);
    expect(model.days[1].rows[0]).toMatchObject({
      time: '9:00 a. m. – 9:30 a. m.',
      patient: 'Pedro Ruiz',
    });
    expect(model.total).toBe(2);
  });

  it('usa el reloj de 24 h si la sede lo tiene', () => {
    const model = buildContingencyAgenda(
      source({
        fmt: regionalFormat({ locale: 'es-ES', hourCycle: 'h23' }),
        timeZone: 'Europe/Madrid',
        appointments: [appt({ start: '2026-11-02T15:00:00Z' })],
      }),
    );
    expect(model.days[0].rows[0].time).toBe('16:00 – 16:30');
  });

  it('ordena por hora y, a la misma hora, por profesional', () => {
    const model = buildContingencyAgenda(
      source({
        appointments: [
          appt({ start: '2026-11-02T14:00:00Z', patientName: 'C' }),
          appt({
            start: '2026-11-02T13:00:00Z',
            patientName: 'B',
            professionalName: 'Zoila Zapata',
          }),
          appt({
            start: '2026-11-02T13:00:00Z',
            patientName: 'A',
            professionalName: 'Ana Abad',
          }),
        ],
      }),
    );
    expect(model.days[0].rows.map((r) => r.patient)).toEqual(['A', 'B', 'C']);
  });

  it('nunca lista las canceladas ni las inasistencias', () => {
    const model = buildContingencyAgenda(
      source({
        appointments: [
          appt({ start: '2026-11-02T13:00:00Z', status: 'CANCELLED' }),
          appt({ start: '2026-11-02T14:00:00Z', status: 'NO_SHOW' }),
          appt({ start: '2026-11-02T15:00:00Z', patientName: 'Viene' }),
        ],
      }),
    );
    expect(model.days[0].rows.map((r) => r.patient)).toEqual(['Viene']);
    expect(model.total).toBe(1);
  });

  it('las alertas no clínicas: confirmación, primera visita, llamada pedida y alerta médica sin detalle', () => {
    const model = buildContingencyAgenda(
      source({
        appointments: [
          appt({
            start: '2026-11-02T13:00:00Z',
            status: 'CONFIRMED',
            firstVisit: true,
            callbackRequested: true,
            medicalAlert: true,
          }),
          appt({ start: '2026-11-02T14:00:00Z', status: 'ARRIVED' }),
          appt({ start: '2026-11-02T15:00:00Z', status: 'COMPLETED' }),
        ],
      }),
    );
    expect(model.days[0].rows.map((r) => r.alerts)).toEqual([
      'Confirmada · Primera visita · Pidió que le llamen · Alerta médica: ver ficha',
      'En la clínica',
      'Atendida',
    ]);
  });

  it('sin teléfono, sin profesional o sin tipo lo dice; un día sin citas queda vacío', () => {
    const model = buildContingencyAgenda(
      source({
        appointments: [
          appt({
            start: '2026-11-02T13:00:00Z',
            phone: null,
            professionalName: null,
            appointmentTypeName: null,
          }),
        ],
      }),
    );
    expect(model.days[0].rows[0]).toMatchObject({
      phone: 'Sin teléfono',
      professional: 'Sin asignar',
      type: 'Sin tipo',
    });
    expect(model.days[1].rows).toEqual([]);
  });

  it('cabecera: clínica, sede, teléfono de la sede, generación con zona IANA y aviso de datos personales', () => {
    const model = buildContingencyAgenda(source());
    expect(model).toMatchObject({
      title: 'Agenda de contingencia',
      clinicName: 'Clínica Demo',
      locationName: 'Sede Centro',
      locationPhone: '+58 212-5550000',
      generatedLabel: 'Generada el 02/11/2026 2:15 a. m. (America/Caracas)',
      generatedAt: new Date('2026-11-02T06:15:00Z'),
    });
    expect(model.notice).toMatch(/datos personales/);
    expect(model.notice).toMatch(/no incluye la historia clínica/i);
  });

  it('lo que la fuente del PDF no pinta se translitera o sale como «?», sin romper', () => {
    const model = buildContingencyAgenda(
      source({
        clinicName: 'Clínica Dvořák',
        appointments: [
          appt({ start: '2026-11-02T13:00:00Z', patientName: '李 Wei\nChen' }),
        ],
      }),
    );
    expect(model.clinicName).toBe('Clínica Dvorák');
    expect(model.days[0].rows[0].patient).toBe('? Wei Chen');
    expect(model.days[0].rows[0].time).not.toMatch(/\u202f/);
  });

  it('solo lleva lo operativo: ni notas ni motivo de la cita, ni nada de la historia', () => {
    const model = buildContingencyAgenda(
      source({ appointments: [appt({ start: '2026-11-02T13:00:00Z' })] }),
    );
    expect(Object.keys(model.days[0].rows[0]).sort()).toEqual([
      'alerts',
      'patient',
      'phone',
      'professional',
      'time',
      'type',
    ]);
  });
});
