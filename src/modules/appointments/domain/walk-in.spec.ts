import { ScheduleBlockKind, TriageFlag } from '@prisma/client';
import {
  TRIAGE_FLAGS,
  findReservedSlot,
  floorToMinute,
  normalizeTriageFlags,
  normalizeTriageNote,
  overbookReasonError,
  triageNoteError,
  type ReservedBlockCandidate,
} from './walk-in';

const URGENT = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const at = (hhmm: string) => new Date(`2026-11-10T${hhmm}:00.000Z`);

function reserved(
  start: string,
  end: string,
  types = [URGENT],
  id = `block-${start}`,
): ReservedBlockCandidate {
  return {
    id,
    kind: ScheduleBlockKind.RESERVED,
    start: at(start),
    end: at(end),
    reservedForTypeIds: types,
  };
}

describe('triaje de «Atender sin cita» (DX-470)', () => {
  it('las 6 señales, en su orden', () => {
    expect(TRIAGE_FLAGS).toEqual([
      'PAIN',
      'SWELLING',
      'INFECTION',
      'FEVER',
      'BLEEDING',
      'TRAUMA',
    ]);
  });

  it('quita repetidas y ordena', () => {
    expect(
      normalizeTriageFlags([
        TriageFlag.TRAUMA,
        TriageFlag.PAIN,
        TriageFlag.TRAUMA,
      ]),
    ).toEqual(['PAIN', 'TRAUMA']);
    expect(normalizeTriageFlags(undefined)).toEqual([]);
  });

  it('la nota se recorta, vacía es null y admite hasta 200', () => {
    expect(normalizeTriageNote('  muela 36  ')).toBe('muela 36');
    expect(normalizeTriageNote('   ')).toBeNull();
    expect(normalizeTriageNote(undefined)).toBeNull();
    expect(triageNoteError('a'.repeat(200))).toBeNull();
    expect(triageNoteError(` ${'a'.repeat(200)} `)).toBeNull();
    expect(triageNoteError('a'.repeat(201))).toBe(
      'La nota de triaje admite como mucho 200 caracteres.',
    );
  });

  it('motivo del sobrecupo: 5–300 y una línea', () => {
    expect(overbookReasonError('Dolor agudo')).toBeNull();
    expect(overbookReasonError('abc')).toMatch(/entre 5 y 300/);
    expect(overbookReasonError('a'.repeat(301))).toMatch(/entre 5 y 300/);
    expect(overbookReasonError('Dolor\nagudo')).toMatch(/una sola línea/);
  });

  it('la hora se redondea al minuto', () => {
    expect(floorToMinute(new Date('2026-11-10T10:07:42.512Z'))).toEqual(
      at('10:07'),
    );
  });
});

describe('findReservedSlot (DX-470)', () => {
  const base = {
    now: at('10:00'),
    until: at('23:59'),
    durationMinutes: 30,
    appointmentTypeId: URGENT,
    busy: [],
  };

  it('sin bloques reservados, ninguno', () => {
    expect(findReservedSlot({ ...base, blocks: [] })).toBeNull();
  });

  it('el reservado de más tarde, a su hora', () => {
    expect(
      findReservedSlot({ ...base, blocks: [reserved('15:00', '15:30')] }),
    ).toEqual({
      start: at('15:00'),
      end: at('15:30'),
      blockId: 'block-15:00',
    });
  });

  it('un reservado en curso: desde ahora', () => {
    expect(
      findReservedSlot({
        ...base,
        now: at('15:10'),
        blocks: [reserved('15:00', '16:00')],
      }),
    ).toMatchObject({ start: at('15:10'), end: at('15:40') });
  });

  it('ignora los que ya pasaron, los de otros tipos y los no reservados', () => {
    expect(
      findReservedSlot({
        ...base,
        blocks: [
          reserved('08:00', '09:00'),
          reserved('11:00', '12:00', [OTHER]),
          {
            ...reserved('12:00', '13:00'),
            kind: ScheduleBlockKind.MEETING,
          },
        ],
      }),
    ).toBeNull();
  });

  it('salta lo ocupado dentro del bloque', () => {
    expect(
      findReservedSlot({
        ...base,
        blocks: [reserved('15:00', '16:00')],
        busy: [{ start: at('15:00'), end: at('15:30') }],
      }),
    ).toMatchObject({ start: at('15:30'), end: at('16:00') });
  });

  it('un bloque lleno no da hueco; elige el siguiente', () => {
    expect(
      findReservedSlot({
        ...base,
        blocks: [reserved('17:00', '17:30'), reserved('15:00', '15:30')],
        busy: [{ start: at('15:00'), end: at('15:30') }],
      }),
    ).toMatchObject({ start: at('17:00'), blockId: 'block-17:00' });
  });

  it('no empieza después del final del día', () => {
    expect(
      findReservedSlot({
        ...base,
        until: at('14:00'),
        blocks: [reserved('15:00', '15:30')],
      }),
    ).toBeNull();
  });

  it('elige el que antes empieza aunque llegue después en la lista', () => {
    expect(
      findReservedSlot({
        ...base,
        blocks: [reserved('16:00', '16:30'), reserved('11:00', '11:30')],
      }),
    ).toMatchObject({ start: at('11:00') });
  });
});
