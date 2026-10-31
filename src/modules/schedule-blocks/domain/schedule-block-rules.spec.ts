import { ScheduleBlockKind } from '@prisma/client';
import {
  MAX_BLOCK_DAYS,
  blockAffects,
  blockConflictMessage,
  blockWarningMessage,
  scheduleBlockNoteError,
  scheduleBlockRangeError,
  scheduleBlockScopeError,
} from './schedule-block-rules';
import type { ScheduleBlock } from './entities/schedule-block.entity';
import { regionalFormat } from '../../../shared/format/regional-format';

const z = (iso: string) => new Date(iso);
/** La sede de las pruebas de siempre: 24 h, día/mes (lo que mostraba). */
const H23 = regionalFormat({ locale: 'es-CO', hourCycle: 'h23' });
const EN_US_H12 = regionalFormat({ locale: 'en-US', hourCycle: 'h12' });
const JA_JP_H23 = regionalFormat({ locale: 'ja-JP', hourCycle: 'h23' });

function block(overrides: Partial<ScheduleBlock> = {}): ScheduleBlock {
  return {
    id: 'b1',
    tenantId: 't1',
    locationId: null,
    providerId: 'doc',
    start: z('2026-10-20T13:00:00.000Z'),
    end: z('2026-10-25T00:00:00.000Z'),
    kind: ScheduleBlockKind.VACATION,
    allowsBooking: false,
    note: null,
    reservedForTypeIds: [],
    releaseAtMinute: null,
    createdById: 'u1',
    createdAt: z('2026-10-01T00:00:00.000Z'),
    updatedAt: z('2026-10-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('reglas de bloqueos (DX-122)', () => {
  it('el rango: fin posterior al inicio y como mucho un año', () => {
    expect(
      scheduleBlockRangeError(
        z('2026-10-20T10:00:00Z'),
        z('2026-10-20T11:00:00Z'),
      ),
    ).toBeNull();
    expect(
      scheduleBlockRangeError(
        z('2026-10-20T10:00:00Z'),
        z('2026-10-20T10:00:00Z'),
      ),
    ).toMatch(/posterior/);
    const tooLong = new Date(
      z('2026-10-20T00:00:00Z').getTime() + (MAX_BLOCK_DAYS + 1) * 86_400_000,
    );
    expect(scheduleBlockRangeError(z('2026-10-20T00:00:00Z'), tooLong)).toMatch(
      /366 días/,
    );
  });

  it('el alcance: sede o profesional', () => {
    expect(
      scheduleBlockScopeError({ providerId: null, locationId: null }),
    ).toMatch(/sede o el profesional/);
    expect(
      scheduleBlockScopeError({ providerId: 'doc', locationId: null }),
    ).toBeNull();
    expect(
      scheduleBlockScopeError({ providerId: null, locationId: 'loc' }),
    ).toBeNull();
  });

  it('la nota: hasta 200 caracteres y no vacía', () => {
    expect(scheduleBlockNoteError('Congreso')).toBeNull();
    expect(scheduleBlockNoteError('   ')).toMatch(/vacía/);
    expect(scheduleBlockNoteError('x'.repeat(201))).toMatch(/200/);
  });

  describe('a quién afecta', () => {
    it('el del profesional en todas las sedes, a sus citas de cualquier sede', () => {
      expect(blockAffects(block(), 'doc', 'loc-a')).toBe(true);
      expect(blockAffects(block(), 'otro', 'loc-a')).toBe(false);
    });
    it('el del profesional en una sede, solo a sus citas de esa sede', () => {
      const b = block({ locationId: 'loc-a' });
      expect(blockAffects(b, 'doc', 'loc-a')).toBe(true);
      expect(blockAffects(b, 'doc', 'loc-b')).toBe(false);
    });
    it('el de toda la sede, a cualquier profesional de esa sede', () => {
      const b = block({ providerId: null, locationId: 'loc-a' });
      expect(blockAffects(b, 'otro', 'loc-a')).toBe(true);
      expect(blockAffects(b, 'otro', 'loc-b')).toBe(false);
    });
  });

  it('el 409 dice el motivo y el rango en la hora de la sede', () => {
    expect(blockConflictMessage(block(), 'America/Bogota', H23)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) del 20/10 08:00 al 24/10 19:00. Elige otro horario.',
    );
    expect(
      blockConflictMessage(
        block({
          providerId: null,
          locationId: 'loc',
          kind: ScheduleBlockKind.MEETING,
        }),
        'America/Bogota',
        H23,
      ),
    ).toBe(
      'La sede tiene la agenda bloqueada (Reunión) del 20/10 08:00 al 24/10 19:00. Elige otro horario.',
    );
  });

  it('el aviso de un bloqueo que deja agendar, con horas del mismo día', () => {
    const lunch = block({
      kind: ScheduleBlockKind.LUNCH,
      allowsBooking: true,
      start: z('2026-10-20T18:00:00.000Z'),
      end: z('2026-10-20T19:00:00.000Z'),
    });
    expect(blockWarningMessage(lunch, 'America/Bogota', H23)).toBe(
      'La cita cae en un bloqueo que permite agendar: Almuerzo (13:00–14:00).',
    );
  });

  it('un bloqueo de días completos se dice con el último día elegido (no «al 23 00:00»)', () => {
    const wholeDays = block({
      start: z('2026-10-21T05:00:00.000Z'), // 21/10 00:00 en Bogotá
      end: z('2026-10-23T05:00:00.000Z'), // 23/10 00:00 = fin del 22
    });
    expect(blockConflictMessage(wholeDays, 'America/Bogota', H23)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) del 21/10 al 22/10. Elige otro horario.',
    );
    const oneDay = block({
      start: z('2026-10-21T05:00:00.000Z'),
      end: z('2026-10-22T05:00:00.000Z'),
    });
    expect(blockConflictMessage(oneDay, 'America/Bogota', H23)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) el 21/10. Elige otro horario.',
    );
  });

  it('block conflict at an en-US h12 location reads del 10/20 8:00 a. m. al 10/24 7:00 p. m.', () => {
    // Las mismas horas de pared en Nueva York (EDT, UTC-4).
    const b = block({
      start: z('2026-10-20T12:00:00.000Z'),
      end: z('2026-10-24T23:00:00.000Z'),
    });
    // Piezas de los vectores dorados: dayMonth «10/27» y time «4:05 p. m.».
    expect(EN_US_H12.dayMonth(b.start, 'America/New_York')).toBe('10/20');
    expect(EN_US_H12.time(b.end, 'America/New_York')).toBe('7:00 p. m.');
    expect(blockConflictMessage(b, 'America/New_York', EN_US_H12)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) del 10/20 8:00 a. m. al 10/24 7:00 p. m. Elige otro horario.',
    );
    const lunch = block({
      kind: ScheduleBlockKind.LUNCH,
      allowsBooking: true,
      start: z('2026-10-20T17:00:00.000Z'),
      end: z('2026-10-20T18:00:00.000Z'),
    });
    expect(blockWarningMessage(lunch, 'America/New_York', EN_US_H12)).toBe(
      'La cita cae en un bloqueo que permite agendar: Almuerzo (1:00 p. m.–2:00 p. m.).',
    );
  });

  it('full-day block is detected at h12 en-US and h23 ja-JP locations', () => {
    // 21/10 00:00 → 23/10 00:00 en Nueva York (EDT): días 21 y 22.
    const ny = block({
      start: z('2026-10-21T04:00:00.000Z'),
      end: z('2026-10-23T04:00:00.000Z'),
    });
    expect(blockConflictMessage(ny, 'America/New_York', EN_US_H12)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) del 10/21 al 10/22. Elige otro horario.',
    );
    // 21/10 00:00 → 22/10 00:00 en Tokio (UTC+9): un solo día.
    const tokyo = block({
      start: z('2026-10-20T15:00:00.000Z'),
      end: z('2026-10-21T15:00:00.000Z'),
    });
    expect(blockConflictMessage(tokyo, 'Asia/Tokyo', JA_JP_H23)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) el 10/21. Elige otro horario.',
    );
    // Medianoche en 12 h es «12:00 a. m.»: no se compara texto.
    const notWhole = block({
      start: z('2026-10-21T04:00:00.000Z'),
      end: z('2026-10-21T16:00:00.000Z'),
    });
    expect(blockConflictMessage(notWhole, 'America/New_York', EN_US_H12)).toBe(
      'La agenda del profesional está bloqueada (Vacaciones) del 10/21 12:00 a. m. al 10/21 12:00 p. m. Elige otro horario.',
    );
  });
});
