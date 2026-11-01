import { ConflictException } from '@nestjs/common';
import { AppointmentStatus, ClinicRole } from '@prisma/client';
import { InMemoryAppointmentRepository } from './__fixtures__/in-memory-appointment.repository';
import { InMemoryScheduleBlockRepository } from '../../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';
import {
  UpdateAppointmentUseCase,
  type AppointmentAuditContext,
} from './update-appointment.use-case';
import type { LocationScheduleRepository } from '../../../location-schedule/domain/ports/location-schedule-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { RecordAuditEventUseCase } from '../../../audit/application/record-audit-event.use-case';
import type { AuditEventDraft } from '../../../audit/domain/audit-event';
import { civilDateIn, civilDayRange } from '../../../../shared/time/civil-day';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { inMemoryAvailability } from '../../../provider-schedule/application/__fixtures__/availability';
import {
  OVERBOOK_SLOT_TAKEN_CODE,
  WALK_IN_MESSAGES,
} from '../../domain/walk-in';
import { OVERLAP_MESSAGES } from '../appointment-overlap-error';

// DX-509: una urgencia en sobrecupo (DX-470) deja de serlo al moverla, y al
// deshacer la llegada o reactivarla solo si su hueco está libre (o se
// mantiene a sabiendas, auditado). Las que se quedan en su hora no cambian.

// Zona en la que AHORA es mediodía (± 1 h): las citas de la prueba caben
// en el mismo día civil (moverlas con el paciente en la clínica lo exige) a
// cualquier hora a la que corra la suite.
const OFFSET = 12 - new Date().getUTCHours();
const TZ =
  OFFSET === 0
    ? 'UTC'
    : OFFSET > 0
      ? `Etc/GMT-${OFFSET}`
      : `Etc/GMT+${-OFFSET}`;
const MIN = 60 * 1000;

const schedule = {
  findByLocation: () => Promise.resolve(null),
} as unknown as LocationScheduleRepository;
const staff = {
  findById: (userId: string) => Promise.resolve({ userId }),
} as unknown as StaffRepository;
const locations = {
  findById: (id: string) => Promise.resolve({ id, timeZone: TZ }),
} as unknown as LocationRepository;
const FOR_PATIENT = {
  byKind: 'STAFF_FOR_PATIENT',
  reasonCode: 'ILLNESS',
} as const;

function ctx(role: ClinicRole = ClinicRole.RECEPTION): AppointmentAuditContext {
  return {
    tenantId: 't1',
    locationId: 'loc1',
    actor: { userId: `u-${role}`, role },
    requestId: 'req-509',
    ip: null,
    userAgent: null,
  };
}

function setup() {
  const repo = new InMemoryAppointmentRepository();
  const drafts: AuditEventDraft[] = [];
  const audit = {
    record: (d: AuditEventDraft) => {
      drafts.push(d);
      return Promise.resolve();
    },
  } as unknown as RecordAuditEventUseCase;
  const uc = new UpdateAppointmentUseCase(
    repo,
    schedule,
    staff,
    audit,
    new InMemoryScheduleBlockRepository(),
    locations,
    new TenantContextService(),
    inMemoryAvailability(),
  );
  // El sobrecupo empieza dentro de 20 min (moverlo exige el futuro) y todo
  // cae antes de la medianoche de la sede.
  const base = Date.now() + 20 * MIN;
  const today = civilDayRange(civilDateIn(new Date(), TZ), TZ);
  expect(base + 3 * 60 * MIN).toBeLessThan(today.end.getTime());
  const t = (offsetMin: number) => new Date(base + offsetMin * MIN);
  /** La urgencia en sobrecupo, en espera (ARRIVED), de 0 a 30. */
  const overbooked = (overrides = {}) =>
    repo.seed({
      start: t(0),
      end: t(30),
      status: AppointmentStatus.ARRIVED,
      preArrivalStatus: AppointmentStatus.SCHEDULED,
      arrivedAt: new Date(),
      walkIn: true,
      overbooked: true,
      patientId: 'p-urg',
      ...overrides,
    });
  /** La cita agendada del mismo profesional encima del sobrecupo. */
  const booked = (overrides = {}) =>
    repo.seed({
      start: t(10),
      end: t(40),
      status: AppointmentStatus.SCHEDULED,
      patientId: 'p-booked',
      ...overrides,
    });
  const reasons = () =>
    drafts.map((d) => (d.metadata as { reason?: string } | undefined)?.reason);
  return { repo, uc, drafts, t, overbooked, booked, reasons };
}

function expectSlotTaken(error: unknown) {
  expect(error).toBeInstanceOf(ConflictException);
  expect((error as ConflictException).getResponse()).toMatchObject({
    statusCode: 409,
    code: OVERBOOK_SLOT_TAKEN_CODE,
    message: WALK_IN_MESSAGES.overbookSlotTaken,
    canKeepOverbooked: true,
  });
}

describe('UpdateAppointmentUseCase · sobrecupo (DX-509)', () => {
  describe('mover', () => {
    it('a otra hora libre: deja de ser sobrecupo, auditado', async () => {
      const { uc, t, overbooked, reasons, repo } = setup();
      const a = overbooked();
      const moved = await uc.execute(a.id, { start: t(60), end: t(90) }, ctx());
      expect(moved.overbooked).toBe(false);
      expect((await repo.findById(a.id))!.overbooked).toBe(false);
      expect(reasons()).toEqual([
        'APPOINTMENT_MOVED',
        'WALK_IN_OVERBOOK_CLEARED',
      ]);
    });

    it('a otro profesional libre a la misma hora: deja de ser sobrecupo', async () => {
      const { uc, overbooked, booked } = setup();
      booked();
      const a = overbooked();
      const moved = await uc.execute(a.id, { providerId: 'prov2' }, ctx());
      expect(moved).toMatchObject({ providerId: 'prov2', overbooked: false });
    });

    it('a una hora que choca con otra cita del profesional: 409 y sigue igual', async () => {
      const { uc, t, overbooked, booked, repo, drafts } = setup();
      booked({ start: t(60), end: t(90) });
      const a = overbooked();
      await expect(
        uc.execute(a.id, { start: t(70), end: t(100) }, ctx()),
      ).rejects.toThrow(new ConflictException(OVERLAP_MESSAGES.provider));
      expect((await repo.findById(a.id))!).toMatchObject({
        start: t(0),
        overbooked: true,
      });
      expect(drafts).toHaveLength(0);
    });

    it('una vez normal, cuenta en el anti-solape: otra cita encima choca', async () => {
      const { uc, t, overbooked, booked } = setup();
      const a = overbooked();
      await uc.execute(a.id, { start: t(60), end: t(90) }, ctx());
      const other = booked({ start: t(120), end: t(150) });
      await expect(
        uc.execute(other.id, { start: t(70), end: t(100) }, ctx()),
      ).rejects.toThrow(new ConflictException(OVERLAP_MESSAGES.provider));
    });
  });

  describe('deshacer la llegada', () => {
    it('con su hueco libre: vuelve a agendada y deja de ser sobrecupo', async () => {
      const { uc, overbooked, reasons } = setup();
      const a = overbooked();
      const undone = await uc.undoArrival(a.id, ctx());
      expect(undone).toMatchObject({
        status: AppointmentStatus.SCHEDULED,
        overbooked: false,
      });
      expect(reasons()).toEqual(['ARRIVAL_UNDONE', 'WALK_IN_OVERBOOK_CLEARED']);
    });

    it('con su hueco ocupado: 409 OVERBOOK_SLOT_TAKEN y no cambia nada', async () => {
      const { uc, overbooked, booked, repo, drafts } = setup();
      booked();
      const a = overbooked();
      const error = await uc.undoArrival(a.id, ctx()).catch((e: unknown) => e);
      expectSlotTaken(error);
      expect((await repo.findById(a.id))!).toMatchObject({
        status: AppointmentStatus.ARRIVED,
        overbooked: true,
      });
      expect(drafts).toHaveLength(0);
    });

    it('con su hueco ocupado y `keepOverbooked`: agendada en sobrecupo, auditado', async () => {
      const { uc, overbooked, booked, reasons } = setup();
      booked();
      const a = overbooked();
      const undone = await uc.undoArrival(a.id, ctx(), {
        keepOverbooked: true,
      });
      expect(undone).toMatchObject({
        status: AppointmentStatus.SCHEDULED,
        overbooked: true,
      });
      expect(reasons()).toEqual(['ARRIVAL_UNDONE', 'WALK_IN_OVERBOOK_KEPT']);
    });

    it('una cita que no es sobrecupo: como siempre, sin evento de sobrecupo', async () => {
      const { uc, overbooked, reasons } = setup();
      const a = overbooked({ overbooked: false });
      await uc.undoArrival(a.id, ctx(), { keepOverbooked: true });
      expect(reasons()).toEqual(['ARRIVAL_UNDONE']);
    });
  });

  describe('reactivar', () => {
    async function cancelled(s: ReturnType<typeof setup>) {
      const a = s.overbooked();
      await s.uc.execute(
        a.id,
        { status: AppointmentStatus.CANCELLED, cancellation: FOR_PATIENT },
        ctx(),
      );
      // Cancelada sigue marcada (no ocupa nada; reactivarla decide).
      expect((await s.repo.findById(a.id))!.overbooked).toBe(true);
      s.drafts.length = 0;
      return a;
    }

    it('con su hueco libre: deja de ser sobrecupo', async () => {
      const s = setup();
      const a = await cancelled(s);
      const back = await s.uc.execute(
        a.id,
        { status: AppointmentStatus.SCHEDULED },
        ctx(),
      );
      expect(back).toMatchObject({
        status: AppointmentStatus.SCHEDULED,
        overbooked: false,
      });
      expect(s.reasons()).toContain('WALK_IN_OVERBOOK_CLEARED');
    });

    it('con su hueco ocupado: 409; con `keepOverbooked`, sigue en sobrecupo y auditado', async () => {
      const s = setup();
      const a = await cancelled(s);
      s.booked();
      const error = await s.uc
        .execute(a.id, { status: AppointmentStatus.SCHEDULED }, ctx())
        .catch((e: unknown) => e);
      expectSlotTaken(error);
      expect((await s.repo.findById(a.id))!.status).toBe(
        AppointmentStatus.CANCELLED,
      );

      const kept = await s.uc.execute(
        a.id,
        { status: AppointmentStatus.SCHEDULED, keepOverbooked: true },
        ctx(),
      );
      expect(kept).toMatchObject({
        status: AppointmentStatus.SCHEDULED,
        overbooked: true,
      });
      expect(s.reasons()).toContain('WALK_IN_OVERBOOK_KEPT');
    });

    it('reactivar y mover a la vez: manda el movimiento (normal y anti-solape)', async () => {
      const s = setup();
      const a = await cancelled(s);
      s.booked();
      const back = await s.uc.execute(
        a.id,
        {
          status: AppointmentStatus.SCHEDULED,
          start: s.t(60),
          end: s.t(90),
        },
        ctx(),
      );
      expect(back.overbooked).toBe(false);
    });
  });

  describe('en su hora', () => {
    it('pasar al sillón, notas o `keepOverbooked` sin reactivar no lo cambian', async () => {
      const { uc, overbooked, booked, reasons } = setup();
      booked();
      const a = overbooked();
      await uc.execute(a.id, { notes: 'Llamó la familia' }, ctx());
      const seated = await uc.execute(
        a.id,
        { status: AppointmentStatus.IN_CHAIR, keepOverbooked: true },
        ctx(ClinicRole.DENTIST),
      );
      expect(seated.overbooked).toBe(true);
      expect(reasons()).not.toContain('WALK_IN_OVERBOOK_CLEARED');
      expect(reasons()).not.toContain('WALK_IN_OVERBOOK_KEPT');
    });
  });
});
