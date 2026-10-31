import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import {
  RESERVED_OVERRIDE_FORBIDDEN_MESSAGE,
  canOverrideReserved,
  evaluateReservedBlock,
  overrideReasonError,
  releaseInstant,
  reservedBlockShapeError,
  reservedConflictMessage,
  type ReservedBlockShape,
} from './reserved-slot';

/** 15:00–15:30 del 2026-11-10 en `zone`, con liberación a las 11:00. */
function reservedIn(
  start: string,
  end: string,
  releaseAtMinute: number | null = 11 * 60,
) {
  return {
    kind: ScheduleBlockKind.RESERVED,
    start: new Date(start),
    end: new Date(end),
    reservedForTypeIds: ['urgencia'],
    releaseAtMinute,
  };
}

// Caracas: UTC−4 fijo. Madrid: 10/11 es horario de invierno (UTC+1).
const CARACAS = 'America/Caracas';
const MADRID = 'Europe/Madrid';
const caracasBlock = reservedIn(
  '2026-11-10T15:00:00-04:00',
  '2026-11-10T15:30:00-04:00',
);
const madridBlock = reservedIn(
  '2026-11-10T15:00:00+01:00',
  '2026-11-10T15:30:00+01:00',
);

describe('releaseInstant (DX-446)', () => {
  it('es la hora de pared del día del bloque en la zona de la sede', () => {
    expect(releaseInstant(caracasBlock, CARACAS)?.toISOString()).toBe(
      '2026-11-10T15:00:00.000Z',
    );
    expect(releaseInstant(madridBlock, MADRID)?.toISOString()).toBe(
      '2026-11-10T10:00:00.000Z',
    );
  });

  it('sin «Liberar a partir de», nunca se libera', () => {
    expect(
      releaseInstant(
        reservedIn(
          '2026-11-10T15:00:00-04:00',
          '2026-11-10T15:30:00-04:00',
          null,
        ),
        CARACAS,
      ),
    ).toBeNull();
  });

  it('respeta el cambio de hora (Madrid en verano, UTC+2)', () => {
    const summer = reservedIn(
      '2026-07-10T15:00:00+02:00',
      '2026-07-10T15:30:00+02:00',
    );
    expect(releaseInstant(summer, MADRID)?.toISOString()).toBe(
      '2026-07-10T09:00:00.000Z',
    );
  });
});

describe('evaluateReservedBlock (DX-446)', () => {
  it.each([
    [
      CARACAS,
      caracasBlock,
      '2026-11-10T10:59:00-04:00',
      '2026-11-10T11:00:00-04:00',
    ],
    [
      MADRID,
      madridBlock,
      '2026-11-10T10:59:00+01:00',
      '2026-11-10T11:00:00+01:00',
    ],
  ])(
    'en %s: tipo permitido siempre; otro tipo, solo desde la liberación',
    (zone, block, before, after) => {
      const at = (iso: string) => new Date(iso);
      expect(
        evaluateReservedBlock(block, {
          appointmentTypeId: 'urgencia',
          now: at(before),
          timeZone: zone,
        }),
      ).toBe('ALLOWED_TYPE');
      expect(
        evaluateReservedBlock(block, {
          appointmentTypeId: 'limpieza',
          now: at(before),
          timeZone: zone,
        }),
      ).toBe('RESERVED');
      expect(
        evaluateReservedBlock(block, {
          appointmentTypeId: 'limpieza',
          now: at(after),
          timeZone: zone,
        }),
      ).toBe('RELEASED');
      expect(
        evaluateReservedBlock(block, {
          appointmentTypeId: null,
          now: at(after),
          timeZone: zone,
        }),
      ).toBe('RELEASED');
    },
  );

  it('sin tipo de cita y sin liberar, está reservado', () => {
    expect(
      evaluateReservedBlock(caracasBlock, {
        appointmentTypeId: null,
        now: new Date('2026-11-09T12:00:00-04:00'),
        timeZone: CARACAS,
      }),
    ).toBe('RESERVED');
  });

  it('la misma hora UTC es liberada en Madrid y no en Caracas', () => {
    const now = new Date('2026-11-10T12:00:00Z');
    // 13:00 en Madrid (pasadas las 11:00); 08:00 en Caracas.
    expect(
      evaluateReservedBlock(madridBlock, {
        appointmentTypeId: 'limpieza',
        now,
        timeZone: MADRID,
      }),
    ).toBe('RELEASED');
    expect(
      evaluateReservedBlock(caracasBlock, {
        appointmentTypeId: 'limpieza',
        now,
        timeZone: CARACAS,
      }),
    ).toBe('RESERVED');
  });
});

describe('reservedBlockShapeError (DX-446)', () => {
  const base: ReservedBlockShape = {
    kind: ScheduleBlockKind.RESERVED,
    start: new Date('2026-11-10T15:00:00-04:00'),
    end: new Date('2026-11-10T15:30:00-04:00'),
    reservedForTypeIds: ['a'],
    releaseAtMinute: 660,
    locationId: 'sede',
    allowsBooking: false,
  };

  it('acepta un reservado válido', () => {
    expect(reservedBlockShapeError(base, CARACAS)).toBeNull();
  });

  it('exige al menos un tipo, sede y no dejar agendar libremente', () => {
    expect(
      reservedBlockShapeError({ ...base, reservedForTypeIds: [] }, CARACAS),
    ).toMatch(/al menos un tipo/);
    expect(
      reservedBlockShapeError({ ...base, locationId: null }, CARACAS),
    ).toMatch(/sede/);
    expect(
      reservedBlockShapeError({ ...base, allowsBooking: true }, CARACAS),
    ).toMatch(/no admite «Permitir agendar»/);
  });

  it('un reservado cabe en un solo día de la sede', () => {
    expect(
      reservedBlockShapeError(
        { ...base, end: new Date('2026-11-11T09:00:00-04:00') },
        CARACAS,
      ),
    ).toMatch(/un solo día/);
  });

  it('la liberación va antes del inicio del bloque', () => {
    expect(
      reservedBlockShapeError({ ...base, releaseAtMinute: 15 * 60 }, CARACAS),
    ).toMatch(/antes del inicio/);
    expect(
      reservedBlockShapeError({ ...base, releaseAtMinute: 1440 }, CARACAS),
    ).toMatch(/hora válida/);
  });

  it('los demás tipos no llevan tipos reservados ni liberación', () => {
    expect(
      reservedBlockShapeError(
        { ...base, kind: ScheduleBlockKind.MEETING, releaseAtMinute: null },
        CARACAS,
      ),
    ).toMatch(/Solo un bloque «Reservado»/);
    expect(
      reservedBlockShapeError(
        { ...base, kind: ScheduleBlockKind.MEETING, reservedForTypeIds: [] },
        CARACAS,
      ),
    ).toMatch(/Solo un bloque «Reservado»/);
    expect(
      reservedBlockShapeError(
        {
          ...base,
          kind: ScheduleBlockKind.LUNCH,
          reservedForTypeIds: [],
          releaseAtMinute: null,
          allowsBooking: true,
        },
        CARACAS,
      ),
    ).toBeNull();
  });
});

describe('override de reservado (DX-446)', () => {
  it('ADMIN y odontólogo pueden; recepción y asistencia no', () => {
    expect(canOverrideReserved(ClinicRole.ADMIN)).toBe(true);
    expect(canOverrideReserved(ClinicRole.DENTIST)).toBe(true);
    expect(canOverrideReserved(ClinicRole.RECEPTION)).toBe(false);
    expect(canOverrideReserved(ClinicRole.ASSISTANT)).toBe(false);
    expect(canOverrideReserved(null)).toBe(false);
    expect(RESERVED_OVERRIDE_FORBIDDEN_MESSAGE).toMatch(/permiso/);
  });

  it('el motivo tiene entre 5 y 300 caracteres tras recortar', () => {
    expect(overrideReasonError('  dolor ')).toBeNull();
    expect(overrideReasonError('abc ')).toMatch(/entre 5 y 300/);
    expect(overrideReasonError('x'.repeat(301))).toMatch(/entre 5 y 300/);
    expect(overrideReasonError('Dolor\nagudo')).toMatch(/una sola línea/);
  });
});

describe('reservedConflictMessage (DX-446)', () => {
  it('nombra los tipos permitidos', () => {
    expect(reservedConflictMessage(['Consulta de urgencia'])).toBe(
      'Ese horario está reservado para urgencias (Consulta de urgencia). Elige otro hueco o usa un tipo permitido.',
    );
    expect(reservedConflictMessage(['Urgencia', 'Dolor agudo'])).toBe(
      'Ese horario está reservado para urgencias (Urgencia, Dolor agudo). Elige otro hueco o usa un tipo permitido.',
    );
  });
});
