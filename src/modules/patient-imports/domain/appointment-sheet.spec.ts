import {
  APPOINTMENT_TEMPLATE_HEADERS,
  MAX_APPOINTMENT_HORIZON_DAYS,
  appointmentTemplateCsv,
  isLocationHoliday,
  nameKey,
  parseDurationMinutes,
  parseTimeOfDay,
  rejectInFileOverlaps,
  resolveAppointmentColumns,
  validateAppointmentRow,
  type ResolvedAppointment,
} from './appointment-sheet';
import { ImportFileError } from './tabular-file';
import { addCivilDays } from '../../../shared/time/civil-day';

// DX-263: lectura y validación de la hoja de citas, fila a fila (sin BD).

const HEADERS = [...APPOINTMENT_TEMPLATE_HEADERS];
const TODAY = '2026-12-01';

function row(
  values: Partial<
    Record<(typeof APPOINTMENT_TEMPLATE_HEADERS)[number], string>
  >,
  rowNumber = 2,
) {
  return {
    rowNumber,
    cells: HEADERS.map((h) => values[h] ?? ''),
  };
}

const valid = {
  numero_documento: 'V-12.345.678',
  fecha: '15/12/2026',
  hora: '09:30',
  duracion_min: '30',
  email_profesional: 'Odontologa@Clinica.com',
};

const check = (values: Parameters<typeof row>[0]) =>
  validateAppointmentRow(
    row(values),
    resolveAppointmentColumns(HEADERS),
    { today: TODAY },
    HEADERS,
  );

describe('resolveAppointmentColumns', () => {
  it('reconoce la plantilla y sinónimos sin tildes ni mayúsculas', () => {
    expect(resolveAppointmentColumns(HEADERS)).toMatchObject({
      docNumber: 'numero_documento',
      date: 'fecha',
      time: 'hora',
      duration: 'duracion_min',
      providerEmail: 'email_profesional',
      location: 'sede',
      appointmentType: 'tipo_cita',
      reason: 'motivo',
    });
    expect(
      resolveAppointmentColumns([
        'Cédula',
        'Fecha de la cita',
        'Hora inicio',
        'Duración',
        'Correo profesional',
      ]),
    ).toMatchObject({
      docNumber: 'Cédula',
      date: 'Fecha de la cita',
      time: 'Hora inicio',
      duration: 'Duración',
      providerEmail: 'Correo profesional',
    });
  });

  it('sin una columna obligatoria: error del archivo en español', () => {
    expect(() =>
      resolveAppointmentColumns(['numero_documento', 'fecha', 'hora']),
    ).toThrow(ImportFileError);
    expect(() =>
      resolveAppointmentColumns(['numero_documento', 'fecha', 'hora']),
    ).toThrow(/le falta la columna «Email del profesional»/);
  });
});

describe('parseTimeOfDay', () => {
  it.each([
    ['09:30', 570],
    ['9:30', 570],
    ['14:05:00', 845],
    ['14h30', 870],
    ['9.15', 555],
    ['9:30 pm', 1290],
    ['12:00 a. m.', 0],
    ['12:15 p.m.', 735],
    ['0.375', 540],
  ])('%s → %d', (raw, minute) => {
    expect(parseTimeOfDay(raw)).toBe(minute);
  });

  it.each(['25:00', '9:75', '13:00 pm', 'mediodía', '', '1.5'])(
    '%s no es una hora',
    (raw) => {
      expect(parseTimeOfDay(raw)).toBeNull();
    },
  );
});

describe('parseDurationMinutes', () => {
  it('admite el número con o sin «min»', () => {
    expect(parseDurationMinutes('30')).toBe(30);
    expect(parseDurationMinutes('45 min')).toBe(45);
    expect(parseDurationMinutes('60 minutos')).toBe(60);
    expect(parseDurationMinutes('media hora')).toBeNull();
    expect(parseDurationMinutes('1,5')).toBeNull();
  });
});

describe('validateAppointmentRow', () => {
  it('una fila válida da la cita normalizada (email en minúsculas)', () => {
    const r = check({ ...valid, sede: 'Sede Chacao', motivo: 'Control' });
    expect(r.issues).toEqual([]);
    expect(r.candidate).toEqual({
      rowNumber: 2,
      docKey: 'V12345678',
      docNumber: 'V-12.345.678',
      date: '2026-12-15',
      minute: 570,
      durationMinutes: 30,
      providerEmail: 'odontologa@clinica.com',
      locationName: 'Sede Chacao',
      typeName: null,
      reason: 'Control',
    });
  });

  it('sin duración pero con tipo: la duración saldrá del tipo', () => {
    const r = check({ ...valid, duracion_min: '', tipo_cita: 'Limpieza' });
    expect(r.issues).toEqual([]);
    expect(r.candidate).toMatchObject({
      durationMinutes: null,
      typeName: 'Limpieza',
    });
  });

  it('sin duración ni tipo: error de la fila', () => {
    const r = check({ ...valid, duracion_min: '' });
    expect(r.candidate).toBeNull();
    expect(r.issues.map((i) => i.message)).toEqual([
      'Falta la duración: escribe los minutos o un tipo de cita (que la trae).',
    ]);
  });

  it('cada dato inválido da su error con fila, columna y valor, en español', () => {
    const r = check({
      numero_documento: '',
      fecha: '31/02/2026',
      hora: '25:00',
      duracion_min: '3',
      email_profesional: 'sin-arroba',
    });
    expect(r.candidate).toBeNull();
    expect(
      r.issues.map((i) => [i.row, i.column, i.kind, i.message, i.value]),
    ).toEqual([
      [
        2,
        'numero_documento',
        'ERROR',
        'Falta el número de documento del paciente.',
        null,
      ],
      [
        2,
        'fecha',
        'ERROR',
        'La fecha de la cita no existe en el calendario.',
        '31/02/2026',
      ],
      [
        2,
        'hora',
        'ERROR',
        'La hora no se reconoce: usa HH:MM en formato de 24 horas (p. ej. 09:30 o 15:00).',
        '25:00',
      ],
      [
        2,
        'duracion_min',
        'ERROR',
        'La duración debe ser un número entero de minutos entre 5 y 480.',
        '3',
      ],
      [
        2,
        'email_profesional',
        'ERROR',
        'El email del profesional no es válido (p. ej. nombre@clinica.com).',
        'sin-arroba',
      ],
    ]);
  });

  it('solo citas futuras y dentro del tope de rango', () => {
    expect(check({ ...valid, fecha: '30/11/2026' }).issues[0].message).toBe(
      'La cita ya pasó: solo se importan citas futuras.',
    );
    const far = addCivilDays(TODAY, MAX_APPOINTMENT_HORIZON_DAYS + 1);
    expect(check({ ...valid, fecha: far }).issues[0].message).toBe(
      `La cita es a más de ${MAX_APPOINTMENT_HORIZON_DAYS} días: solo se importan las citas del próximo año.`,
    );
    const edge = addCivilDays(TODAY, MAX_APPOINTMENT_HORIZON_DAYS);
    expect(check({ ...valid, fecha: edge }).issues).toEqual([]);
    // Hoy sí (la hora exacta se compara después, en la zona de la sede).
    expect(check({ ...valid, fecha: TODAY }).issues).toEqual([]);
  });

  it('documento en notación científica de Excel: error', () => {
    expect(
      check({ ...valid, numero_documento: '1.2345E+7' }).issues[0].message,
    ).toMatch(/notación científica/);
  });

  it('motivo de más de 1000 caracteres: error', () => {
    expect(
      check({ ...valid, motivo: 'x'.repeat(1001) }).issues[0],
    ).toMatchObject({
      column: 'motivo',
      message: 'El motivo tiene más de 1000 caracteres.',
    });
  });

  it('una fila con celdas de más: error', () => {
    const r = validateAppointmentRow(
      { ...row(valid), extraCells: true },
      resolveAppointmentColumns(HEADERS),
      { today: TODAY },
      HEADERS,
    );
    expect(r.candidate).toBeNull();
  });
});

describe('rejectInFileOverlaps', () => {
  const at = (
    rowNumber: number,
    providerId: string,
    docKey: string,
    from: string,
    to: string,
  ): ResolvedAppointment => ({
    rowNumber,
    docKey,
    patientId: null,
    providerId,
    locationId: 'loc',
    appointmentTypeId: null,
    start: new Date(`2026-12-15T${from}:00Z`),
    end: new Date(`2026-12-15T${to}:00Z`),
    reason: null,
  });

  it('gana la fila anterior; la otra sale con el motivo (profesional o paciente)', () => {
    const { kept, issues } = rejectInFileOverlaps([
      at(4, 'dra', 'P2', '13:15', '13:45'),
      at(2, 'dra', 'P1', '13:00', '13:30'),
      at(3, 'dr', 'P1', '13:20', '13:50'),
      // Contiguas: [13:30, 14:00) no pisa [13:00, 13:30).
      at(5, 'dra', 'P3', '13:30', '14:00'),
    ]);
    expect(kept.map((k) => k.rowNumber)).toEqual([2, 5]);
    expect(issues).toEqual([
      {
        row: 3,
        column: null,
        kind: 'ERROR',
        message:
          'Se solapa con la cita de la fila 2 del archivo: el paciente ya tiene una cita a esa hora.',
        value: null,
      },
      {
        row: 4,
        column: null,
        kind: 'ERROR',
        message:
          'Se solapa con la cita de la fila 2 del archivo: el profesional ya tiene una cita a esa hora.',
        value: null,
      },
    ]);
  });
});

describe('isLocationHoliday', () => {
  it('fecha exacta o, si es recurrente, el mismo día y mes de cada año', () => {
    const holidays = [
      { date: '2026-12-24', recurring: false },
      { date: '2020-12-25', recurring: true },
    ];
    expect(isLocationHoliday('2026-12-24', holidays)).toBe(true);
    expect(isLocationHoliday('2027-12-24', holidays)).toBe(false);
    expect(isLocationHoliday('2027-12-25', holidays)).toBe(true);
    expect(isLocationHoliday('2026-12-26', holidays)).toBe(false);
  });
});

describe('nameKey y plantilla', () => {
  it('compara nombres sin tildes, mayúsculas ni espacios de más', () => {
    expect(nameKey('  Sede  Chacáo ')).toBe(nameKey('sede chacao'));
  });

  it('la plantilla trae las columnas y una cita de ejemplo la semana próxima', () => {
    const csv = appointmentTemplateCsv('2026-12-01');
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv).toContain(
      '"numero_documento","fecha","hora","duracion_min","email_profesional","sede","tipo_cita","motivo"',
    );
    expect(csv).toContain('"08/12/2026","09:30","30"');
  });
});
