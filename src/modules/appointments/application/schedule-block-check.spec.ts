import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import { checkScheduleBlocks } from './schedule-block-check';
import { InMemoryScheduleBlockRepository } from '../../schedule-blocks/application/__fixtures__/in-memory-schedule-blocks';

// DX-446: reglas del hueco reservado al agendar o mover una cita.
const Q = {
  providerId: 'prov1',
  locationId: 'loc1',
  start: new Date('2026-11-10T15:00:00+01:00'),
  end: new Date('2026-11-10T15:30:00+01:00'),
};
const BEFORE_RELEASE = new Date('2026-11-10T10:30:00+01:00');
const AFTER_RELEASE = new Date('2026-11-10T11:00:00+01:00');

function makeRepo(timeZone: string): InMemoryScheduleBlockRepository {
  const repo = new InMemoryScheduleBlockRepository();
  repo.timeZone = timeZone;
  repo.types.push({
    id: 'urg',
    name: 'Consulta de urgencia',
    color: '#DC2626',
    isUrgent: true,
    active: true,
  });
  return repo;
}

describe('checkScheduleBlocks con huecos reservados (DX-446)', () => {
  let repo: InMemoryScheduleBlockRepository;

  beforeEach(() => {
    repo = makeRepo('Europe/Madrid');
    repo.seed({
      providerId: 'prov1',
      locationId: 'loc1',
      start: Q.start,
      end: Q.end,
      kind: ScheduleBlockKind.RESERVED,
      reservedForTypeIds: ['urg'],
      releaseAtMinute: 11 * 60,
    });
  });

  it('el tipo permitido agenda sin avisos', async () => {
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'urg',
        now: BEFORE_RELEASE,
        actorRole: ClinicRole.RECEPTION,
      }),
    ).resolves.toEqual({ warnings: [], override: null });
  });

  it('otro tipo antes de la liberación: 409 en español con los tipos permitidos', async () => {
    const attempt = checkScheduleBlocks(repo, Q, {
      appointmentTypeId: 'limpieza',
      now: BEFORE_RELEASE,
      actorRole: ClinicRole.RECEPTION,
    });
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await attempt.catch((error: ConflictException) => {
      expect(error.getResponse()).toMatchObject({
        code: 'RESERVED_SLOT',
        canOverride: false,
        message:
          'Ese horario está reservado para urgencias (Consulta de urgencia). Elige otro hueco o usa un tipo permitido.',
      });
    });
  });

  it('el 409 dice si quien agenda puede saltarse la reserva', async () => {
    await checkScheduleBlocks(repo, Q, {
      appointmentTypeId: null,
      now: BEFORE_RELEASE,
      actorRole: ClinicRole.DENTIST,
    }).catch((error: ConflictException) => {
      expect(error.getResponse()).toMatchObject({ canOverride: true });
    });
  });

  it('pasada la liberación (hora de Madrid), cualquier tipo agenda', async () => {
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'limpieza',
        now: AFTER_RELEASE,
        actorRole: ClinicRole.RECEPTION,
      }),
    ).resolves.toEqual({ warnings: [], override: null });
  });

  it('en Caracas la misma hora UTC aún no libera', async () => {
    const caracas = makeRepo('America/Caracas');
    const start = new Date('2026-11-10T15:00:00-04:00');
    caracas.seed({
      providerId: 'prov1',
      locationId: 'loc1',
      start,
      end: new Date('2026-11-10T15:30:00-04:00'),
      kind: ScheduleBlockKind.RESERVED,
      reservedForTypeIds: ['urg'],
      releaseAtMinute: 11 * 60,
    });
    const q = { ...Q, start, end: new Date('2026-11-10T15:30:00-04:00') };
    // 10:00 UTC = 06:00 en Caracas.
    await expect(
      checkScheduleBlocks(caracas, q, {
        appointmentTypeId: 'limpieza',
        now: new Date('2026-11-10T10:00:00Z'),
        actorRole: ClinicRole.RECEPTION,
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      checkScheduleBlocks(caracas, q, {
        appointmentTypeId: 'limpieza',
        now: new Date('2026-11-10T11:00:00-04:00'),
        actorRole: ClinicRole.RECEPTION,
      }),
    ).resolves.toEqual({ warnings: [], override: null });
  });

  it('override con permiso y motivo: pasa y devuelve lo que se auditará', async () => {
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'limpieza',
        now: BEFORE_RELEASE,
        actorRole: ClinicRole.DENTIST,
        overrideReason: '  Paciente con dolor  ',
      }),
    ).resolves.toEqual({
      warnings: [],
      override: {
        blockIds: [repo.rows[0].id],
        reason: 'Paciente con dolor',
      },
    });
  });

  it('motivo sin permiso: 403; motivo corto: 400', async () => {
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'limpieza',
        now: BEFORE_RELEASE,
        actorRole: ClinicRole.RECEPTION,
        overrideReason: 'Paciente con dolor',
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'limpieza',
        now: BEFORE_RELEASE,
        actorRole: ClinicRole.ADMIN,
        overrideReason: 'ay',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('un motivo donde no hay nada reservado no se audita', async () => {
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'urg',
        now: BEFORE_RELEASE,
        actorRole: ClinicRole.ADMIN,
        overrideReason: 'Por si acaso',
      }),
    ).resolves.toEqual({ warnings: [], override: null });
  });

  it('un bloqueo que no deja agendar sigue siendo 409 aunque haya override', async () => {
    repo.seed({
      providerId: 'prov1',
      locationId: null,
      start: Q.start,
      end: Q.end,
      kind: ScheduleBlockKind.VACATION,
    });
    await expect(
      checkScheduleBlocks(repo, Q, {
        appointmentTypeId: 'limpieza',
        now: BEFORE_RELEASE,
        actorRole: ClinicRole.ADMIN,
        overrideReason: 'Paciente con dolor',
      }),
    ).rejects.toThrow(/bloqueada \(Vacaciones\)/);
  });
});
