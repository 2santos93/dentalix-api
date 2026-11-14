import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import { InMemoryProviderScheduleRepository } from '../../../provider-schedule/application/__fixtures__/in-memory-provider-schedule.repository';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';
import { PROVIDER_OFF_SCHEDULE_STRICT_SUFFIX } from '../../../provider-schedule/application/provider-availability.service';
import {
  UpdateAppointmentUseCase,
  type AppointmentAuditContext,
} from './update-appointment.use-case';
import type { UpdateAppointmentRepoInput } from '../../domain/ports/appointment-repository.port';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { BusinessHours } from '../../../location-schedule/application/business-hours';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { LOCATION_INACTIVE_CODE } from '../../../../shared/tenancy/active-location';
import { PROVIDER_NOT_AT_LOCATION_MESSAGE } from '../../../staff/domain/provider-location';
import { NOT_ATTENDING_MESSAGE } from '../../../staff/domain/attending';
import { RESERVED_OVERRIDE_FORBIDDEN_MESSAGE } from '../../../schedule-blocks/domain/reserved-slot';
import { OVERBOOK_SLOT_TAKEN_CODE } from '../../domain/walk-in';
import { APPOINTMENT_PAST_CODE, APPOINTMENT_PAST_MESSAGE } from '../slot-rules';

// DX-267-bis (BE-039): reactivar una cita (CANCELLED/NO_SHOW → SCHEDULED o
// CONFIRMED en su hora) pasa por las MISMAS reglas que moverla, más «ya
// pasó». Un test por regla. Reloj fijo: nada depende de la hora de la corrida.

const MIN = 60 * 1000;
/** «Ahora» del reloj inyectado: lunes 4 de marzo de 2030, 08:00 en Caracas. */
const NOW = new Date('2030-03-04T12:00:00.000Z');
/** La cita: martes 5, 10:00–10:30 en Caracas (UTC−4). */
const START = new Date('2030-03-05T14:00:00.000Z');
const END = new Date('2030-03-05T14:30:00.000Z');
const TUESDAY = 2;

interface Member {
  userId: string;
  role: ClinicRole;
  locationIds: string[] | null;
}

function ctx(role: ClinicRole = ClinicRole.RECEPTION): AppointmentAuditContext {
  return {
    tenantId: 't1',
    locationId: 'loc1',
    actor: { userId: `u-${role}`, role },
    requestId: 'req-267b',
    ip: null,
    userAgent: null,
  };
}

interface SetupOptions {
  hours?: BusinessHours | null;
  locationActive?: boolean;
  members?: Member[];
  now?: Date;
}

function setup(options: SetupOptions = {}) {
  const repo = new InMemoryAppointmentRepository();
  const patches: UpdateAppointmentRepoInput[] = [];
  const update = repo.update.bind(repo);
  repo.update = (id, patch) => {
    patches.push(patch);
    return update(id, patch);
  };
  const blocks = new InMemoryScheduleBlockRepository();
  const schedules = new InMemoryProviderScheduleRepository();
  const hours = options.hours ?? null;
  const schedule = {
    findByLocation: () => Promise.resolve(hours),
    formatSourceOf: (id: string) =>
      Promise.resolve({ id, locale: 'es-VE', hourCycle: 'h23' }),
  } as unknown as LocationScheduleRepository;
  const members = options.members ?? [
    { userId: 'prov1', role: ClinicRole.DENTIST, locationIds: null },
  ];
  const staff = {
    findById: (userId: string) =>
      Promise.resolve(members.find((m) => m.userId === userId) ?? null),
  } as unknown as StaffRepository;
  const locations = {
    findById: (id: string) =>
      Promise.resolve({
        id,
        name: 'Sede Chacao',
        timeZone: 'America/Caracas',
        isActive: options.locationActive ?? true,
      }),
  } as unknown as LocationRepository;
  const audit = {
    record: () => Promise.resolve(),
  } as unknown as RecordAuditEventUseCase;
  const now = options.now ?? NOW;
  const uc = new UpdateAppointmentUseCase(
    repo,
    schedule,
    staff,
    audit,
    blocks,
    locations,
    new TenantContextService(),
    inMemoryAvailability(schedules, 'America/Caracas', {
      locale: 'es-VE',
      hourCycle: 'h23',
    }),
    () => now,
  );
  /** Una cita cancelada (por defecto) del martes 10:00–10:30. */
  const cancelled = (overrides = {}) =>
    repo.seed({
      start: START,
      end: END,
      status: AppointmentStatus.CANCELLED,
      ...overrides,
    });
  return { repo, uc, blocks, schedules, cancelled, patches };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => {
      throw new Error('se esperaba un error');
    },
    (error: unknown) => error,
  );
}

function body(error: unknown): unknown {
  return (error as ConflictException).getResponse();
}

const SCHEDULED = { status: AppointmentStatus.SCHEDULED };

describe('UpdateAppointmentUseCase · reactivar con las reglas de mover (DX-267-bis)', () => {
  it('dentro de todas las reglas: 200, sin avisos, y el repo vuelve a mirar el hueco', async () => {
    const { uc, cancelled, patches } = setup();
    const a = cancelled();
    const result = await uc.execute(a.id, SCHEDULED, ctx());
    expect(result.status).toBe(AppointmentStatus.SCHEDULED);
    expect(result.warnings).toEqual([]);
    expect(patches[0]).toMatchObject({ recheckSlot: true });
  });

  it('también a CONFIRMED y desde NO_SHOW', async () => {
    const { uc, cancelled, patches } = setup();
    const a = cancelled({ status: AppointmentStatus.NO_SHOW });
    const result = await uc.execute(
      a.id,
      { status: AppointmentStatus.CONFIRMED },
      ctx(),
    );
    expect(result.status).toBe(AppointmentStatus.CONFIRMED);
    expect(patches[0]).toMatchObject({ recheckSlot: true });
  });

  describe('ya pasó', () => {
    it('una cancelada que ya terminó: 409 APPOINTMENT_PAST y nada cambia', async () => {
      const { uc, cancelled, repo, patches } = setup({
        now: new Date(END.getTime() + MIN),
      });
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(error).toBeInstanceOf(ConflictException);
      expect(body(error)).toEqual({
        statusCode: 409,
        error: 'Conflict',
        code: APPOINTMENT_PAST_CODE,
        message: APPOINTMENT_PAST_MESSAGE,
      });
      expect(APPOINTMENT_PAST_MESSAGE).toBe(
        'La cita ya pasó: agenda una nueva',
      );
      expect(patches).toHaveLength(0);
      expect((await repo.findById(a.id))!.status).toBe(
        AppointmentStatus.CANCELLED,
      );
    });

    it('justo al terminar (fin = ahora) ya pasó', async () => {
      const { uc, cancelled } = setup({ now: END });
      const a = cancelled();
      expect(body(await rejection(uc.execute(a.id, SCHEDULED, ctx())))).toEqual(
        expect.objectContaining({ code: APPOINTMENT_PAST_CODE }),
      );
    });

    it('un no-show en curso (empezó, no terminó: llegó tarde) se reactiva', async () => {
      const { uc, cancelled } = setup({
        now: new Date(START.getTime() + 10 * MIN),
      });
      const a = cancelled({ status: AppointmentStatus.NO_SHOW });
      const result = await uc.execute(a.id, SCHEDULED, ctx());
      expect(result.status).toBe(AppointmentStatus.SCHEDULED);
    });

    it('pasar a COMPLETED una cancelada pasada no mira reglas (corregir el registro)', async () => {
      const { uc, cancelled, patches } = setup({
        now: new Date(END.getTime() + 24 * 60 * MIN),
        locationActive: false,
        members: [],
      });
      const a = cancelled();
      const result = await uc.execute(
        a.id,
        { status: AppointmentStatus.COMPLETED },
        ctx(),
      );
      expect(result.status).toBe(AppointmentStatus.COMPLETED);
      expect(patches[0].recheckSlot).toBeUndefined();
    });

    it('CANCELLED → NO_SHOW de una cita pasada no mira reglas', async () => {
      const { uc, cancelled, patches } = setup({
        now: new Date(END.getTime() + 60 * MIN),
      });
      const a = cancelled();
      const result = await uc.execute(
        a.id,
        { status: AppointmentStatus.NO_SHOW },
        ctx(),
      );
      expect(result.status).toBe(AppointmentStatus.NO_SHOW);
      expect(patches[0].recheckSlot).toBeUndefined();
    });
  });

  it('sede desactivada (SEC-014): 400 LOCATION_INACTIVE', async () => {
    const { uc, cancelled } = setup({ locationActive: false });
    const a = cancelled();
    const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
    expect(error).toBeInstanceOf(BadRequestException);
    expect(body(error)).toEqual(
      expect.objectContaining({ code: LOCATION_INACTIVE_CODE }),
    );
  });

  describe('el profesional, aunque no cambie', () => {
    it('ya no es de la clínica: 404', async () => {
      const { uc, cancelled } = setup({ members: [] });
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(error).toBeInstanceOf(NotFoundException);
      expect((error as Error).message).toBe('Profesional no encontrado');
    });

    it('ya no atiende en la sede de la cita: 400', async () => {
      const { uc, cancelled } = setup({
        members: [
          { userId: 'prov1', role: ClinicRole.DENTIST, locationIds: ['loc2'] },
        ],
      });
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(PROVIDER_NOT_AT_LOCATION_MESSAGE);
    });

    it('ya no tiene un rol que atiende: 400', async () => {
      const { uc, cancelled } = setup({
        members: [
          { userId: 'prov1', role: ClinicRole.RECEPTION, locationIds: null },
        ],
      });
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(NOT_ATTENDING_MESSAGE);
    });
  });

  it('fuera del horario de la sede: 422 con el texto de siempre', async () => {
    const { uc, cancelled } = setup({
      hours: {
        timezone: 'America/Caracas',
        ranges: [
          { weekday: TUESDAY, startMinute: 14 * 60, endMinute: 18 * 60 },
        ],
      },
    });
    const a = cancelled();
    const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as Error).message).toMatch(/^Fuera del horario de atención/);
  });

  describe('horario del profesional', () => {
    function offSchedule(strict: boolean) {
      const s = setup();
      // Los martes atiende solo por la tarde.
      s.schedules.weekly.set('prov1', [
        {
          locationId: 'loc1',
          weekday: TUESDAY,
          startMinute: 14 * 60,
          endMinute: 18 * 60,
        },
      ]);
      s.schedules.strict = strict;
      return s;
    }

    it('fuera de él: 200 con el aviso PROVIDER_OFF_SCHEDULE', async () => {
      const { uc, cancelled } = offSchedule(false);
      const a = cancelled();
      const result = await uc.execute(a.id, SCHEDULED, ctx());
      expect(result.status).toBe(AppointmentStatus.SCHEDULED);
      expect(result.warningCodes).toEqual(['PROVIDER_OFF_SCHEDULE']);
      expect(result.warnings[0]).toMatch(/^Fuera del horario del profesional/);
    });

    it('en modo estricto: 409 con el sufijo', async () => {
      const { uc, cancelled } = offSchedule(true);
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toContain(
        PROVIDER_OFF_SCHEDULE_STRICT_SUFFIX,
      );
    });
  });

  describe('bloqueos', () => {
    it('uno que no deja agendar (creado tras cancelar): 409', async () => {
      const { uc, cancelled, blocks } = setup();
      const a = cancelled();
      blocks.seed({
        providerId: 'prov1',
        start: new Date('2030-03-05T12:00:00.000Z'),
        end: new Date('2030-03-05T22:00:00.000Z'),
        allowsBooking: false,
      });
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as Error).message).toMatch(
        /^La agenda del profesional está bloqueada/,
      );
    });

    it('uno que deja agendar: 200 con su aviso', async () => {
      const { uc, cancelled, blocks } = setup();
      const a = cancelled();
      blocks.seed({
        providerId: null,
        locationId: 'loc1',
        kind: 'LUNCH',
        allowsBooking: true,
        start: START,
        end: END,
      });
      const result = await uc.execute(a.id, SCHEDULED, ctx());
      expect(result.warningCodes).toEqual(['SCHEDULE_BLOCK']);
    });

    function reserved() {
      const s = setup();
      s.blocks.seed({
        kind: 'RESERVED',
        providerId: 'prov1',
        locationId: 'loc1',
        allowsBooking: false,
        start: START,
        end: END,
        reservedForTypeIds: ['type-ortho'],
      });
      return s;
    }

    it('hueco reservado para otro tipo: 409 RESERVED_SLOT', async () => {
      const { uc, cancelled } = reserved();
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(body(error)).toEqual(
        expect.objectContaining({ code: 'RESERVED_SLOT', canOverride: false }),
      );
    });

    it('hueco reservado con motivo de un ADMIN: 200 y `reservedOverride`', async () => {
      const { uc, cancelled } = reserved();
      const a = cancelled();
      const result = await uc.execute(
        a.id,
        { ...SCHEDULED, overrideReason: 'Paciente prioritario' },
        ctx(ClinicRole.ADMIN),
      );
      expect(result.status).toBe(AppointmentStatus.SCHEDULED);
      expect(result.reservedOverride).toEqual({
        blockIds: [expect.any(String)],
        reason: 'Paciente prioritario',
      });
    });
  });

  describe('solapes', () => {
    it('el paciente ya tiene otra cita a esa hora: 409 scope patient', async () => {
      const { uc, cancelled, repo } = setup();
      const a = cancelled();
      repo.seed({ start: START, end: END, providerId: 'prov2' });
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(body(error)).toEqual(
        expect.objectContaining({
          code: 'APPOINTMENT_OVERLAP',
          scope: 'patient',
        }),
      );
    });

    it('el profesional ya tiene otra cita a esa hora: 409 scope provider', async () => {
      const { uc, cancelled, repo } = setup();
      const a = cancelled();
      repo.seed({ start: START, end: END, patientId: 'p2' });
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(body(error)).toEqual(
        expect.objectContaining({
          code: 'APPOINTMENT_OVERLAP',
          scope: 'provider',
        }),
      );
    });

    it('un sobrecupo con su hueco ocupado sigue en OVERBOOK_SLOT_TAKEN (DX-509)', async () => {
      const { uc, cancelled, repo } = setup();
      const a = cancelled({ walkIn: true, overbooked: true });
      repo.seed({ start: START, end: END, patientId: 'p2' });
      const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
      expect(body(error)).toEqual(
        expect.objectContaining({
          code: OVERBOOK_SLOT_TAKEN_CODE,
          canKeepOverbooked: true,
        }),
      );
      const kept = await uc.execute(
        a.id,
        { ...SCHEDULED, keepOverbooked: true },
        ctx(),
      );
      expect(kept.overbooked).toBe(true);
    });
  });

  describe('urgencia (walkIn): las excepciones de su alta', () => {
    it('fuera del horario de la sede: se reactiva', async () => {
      const { uc, cancelled } = setup({
        hours: {
          timezone: 'America/Caracas',
          ranges: [
            { weekday: TUESDAY, startMinute: 14 * 60, endMinute: 18 * 60 },
          ],
        },
      });
      const a = cancelled({ walkIn: true });
      const result = await uc.execute(a.id, SCHEDULED, ctx());
      expect(result.status).toBe(AppointmentStatus.SCHEDULED);
    });

    it('fuera del horario del profesional en modo estricto: aviso, no 409', async () => {
      const { uc, cancelled, schedules } = setup();
      schedules.weekly.set('prov1', [
        {
          locationId: 'loc1',
          weekday: TUESDAY,
          startMinute: 14 * 60,
          endMinute: 18 * 60,
        },
      ]);
      schedules.strict = true;
      const a = cancelled({ walkIn: true });
      const result = await uc.execute(a.id, SCHEDULED, ctx());
      expect(result.warningCodes).toEqual(['PROVIDER_OFF_SCHEDULE']);
    });

    it('ya terminada: también 409 APPOINTMENT_PAST', async () => {
      const { uc, cancelled } = setup({ now: new Date(END.getTime() + MIN) });
      const a = cancelled({ walkIn: true });
      expect(body(await rejection(uc.execute(a.id, SCHEDULED, ctx())))).toEqual(
        expect.objectContaining({ code: APPOINTMENT_PAST_CODE }),
      );
    });
  });

  it('reactivar y mover a la vez va por mover (400 al pasado, no 409)', async () => {
    const { uc, cancelled } = setup();
    const a = cancelled();
    const error = await rejection(
      uc.execute(
        a.id,
        {
          ...SCHEDULED,
          start: new Date('2020-01-01T14:00:00.000Z'),
          end: new Date('2020-01-01T14:30:00.000Z'),
        },
        ctx(),
      ),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      'No se puede reagendar una cita al pasado',
    );
  });
  it('orden: una cita pasada con el profesional ya retirado da APPOINTMENT_PAST, no 404', async () => {
    const { uc, cancelled } = setup({
      now: new Date(END.getTime() + MIN),
      members: [],
    });
    const a = cancelled();
    const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
    expect(body(error)).toEqual(
      expect.objectContaining({ code: APPOINTMENT_PAST_CODE }),
    );
  });

  it('orden: con la sede desactivada, SEC-014 va antes que «ya pasó»', async () => {
    const { uc, cancelled } = setup({
      now: new Date(END.getTime() + MIN),
      locationActive: false,
    });
    const a = cancelled();
    const error = await rejection(uc.execute(a.id, SCHEDULED, ctx()));
    expect(body(error)).toEqual(
      expect.objectContaining({ code: LOCATION_INACTIVE_CODE }),
    );
  });

  it('`overrideReason` de recepción al reactivar: 403, aunque no haya hueco reservado', async () => {
    const { uc, cancelled, repo } = setup();
    const a = cancelled();
    const error = await rejection(
      uc.execute(
        a.id,
        { ...SCHEDULED, overrideReason: 'Paciente prioritario' },
        ctx(ClinicRole.RECEPTION),
      ),
    );
    expect(error).toBeInstanceOf(ForbiddenException);
    expect((error as Error).message).toBe(RESERVED_OVERRIDE_FORBIDDEN_MESSAGE);
    expect((await repo.findById(a.id))!.status).toBe(
      AppointmentStatus.CANCELLED,
    );
  });

  describe('reactivar y mover a la vez revisa el profesional aunque no cambie', () => {
    const moved = {
      ...SCHEDULED,
      start: new Date(START.getTime() + 5 * MIN),
      end: new Date(END.getTime() + 5 * MIN),
    };

    it('ya no atiende en la sede: 400', async () => {
      const { uc, cancelled } = setup({
        members: [
          { userId: 'prov1', role: ClinicRole.DENTIST, locationIds: ['loc2'] },
        ],
      });
      const a = cancelled();
      const error = await rejection(uc.execute(a.id, moved, ctx()));
      expect(error).toBeInstanceOf(BadRequestException);
      expect((error as Error).message).toBe(PROVIDER_NOT_AT_LOCATION_MESSAGE);
    });

    it('ya no es de la clínica (desde NO_SHOW): 404', async () => {
      const { uc, cancelled } = setup({ members: [] });
      const a = cancelled({ status: AppointmentStatus.NO_SHOW });
      const error = await rejection(uc.execute(a.id, moved, ctx()));
      expect(error).toBeInstanceOf(NotFoundException);
    });

    it('una cita viva que solo se mueve no vuelve a mirar al profesional (como siempre)', async () => {
      const { uc, cancelled } = setup({ members: [] });
      const a = cancelled({ status: AppointmentStatus.SCHEDULED });
      const result = await uc.execute(
        a.id,
        { start: moved.start, end: moved.end },
        ctx(),
      );
      expect(result.start).toEqual(moved.start);
    });
  });

  it('mover usa el reloj inyectado para «al pasado»', async () => {
    // El reloj va un día por delante de la cita: moverla 5 min es «al pasado».
    const { uc, cancelled } = setup({
      now: new Date(END.getTime() + 24 * 60 * MIN),
    });
    const a = cancelled({ status: AppointmentStatus.SCHEDULED });
    const error = await rejection(
      uc.execute(
        a.id,
        {
          start: new Date(START.getTime() + 5 * MIN),
          end: new Date(END.getTime() + 5 * MIN),
        },
        ctx(),
      ),
    );
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as Error).message).toBe(
      'No se puede reagendar una cita al pasado',
    );
  });
});
