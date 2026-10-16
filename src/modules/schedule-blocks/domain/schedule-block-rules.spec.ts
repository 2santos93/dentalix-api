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

const z = (iso: string) => new Date(iso);

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
    expect(blockConflictMessage(block(), 'America/Bogota')).toBe(
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
    expect(blockWarningMessage(lunch, 'America/Bogota')).toBe(
      'La cita cae en un bloqueo que permite agendar: Almuerzo (13:00–14:00).',
    );
  });
});
