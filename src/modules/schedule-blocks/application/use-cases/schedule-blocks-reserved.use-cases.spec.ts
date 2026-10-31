import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ClinicRole, ScheduleBlockKind } from '@prisma/client';
import {
  CreateScheduleBlockUseCase,
  ListScheduleBlocksUseCase,
  UpdateScheduleBlockUseCase,
  type ScheduleBlockActor,
} from './schedule-blocks.use-cases';
import { InMemoryScheduleBlockRepository } from '../__fixtures__/in-memory-schedule-blocks';
import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

// DX-446: bloques RESERVED (tipos permitidos, liberación, tipos de otra clínica).
const ADMIN: ScheduleBlockActor = { userId: 'admin', role: ClinicRole.ADMIN };

const locations = {
  findById: (id: string) =>
    Promise.resolve(id === 'loc1' ? { id, timeZone: 'America/Caracas' } : null),
} as unknown as LocationRepository;
const staff = {
  findById: (userId: string) =>
    Promise.resolve(
      userId === 'doc' ? { userId, role: ClinicRole.DENTIST } : null,
    ),
} as unknown as StaffRepository;

/** 15:00–15:30 de Caracas (UTC−4) del 10/11/2026. */
const RESERVED = {
  providerId: 'doc',
  locationId: 'loc1',
  start: new Date('2026-11-10T19:00:00.000Z'),
  end: new Date('2026-11-10T19:30:00.000Z'),
  kind: ScheduleBlockKind.RESERVED,
  reservedForTypeIds: ['urg'],
  releaseAtMinute: 11 * 60,
};

describe('bloques reservados (DX-446)', () => {
  let repo: InMemoryScheduleBlockRepository;
  let create: CreateScheduleBlockUseCase;
  let update: UpdateScheduleBlockUseCase;
  let now: Date;
  let list: ListScheduleBlocksUseCase;

  beforeEach(() => {
    repo = new InMemoryScheduleBlockRepository();
    repo.timeZone = 'America/Caracas';
    repo.types.push(
      {
        id: 'urg',
        name: 'Consulta de urgencia',
        color: '#DC2626',
        isUrgent: true,
        active: true,
      },
      {
        id: 'off',
        name: 'Antiguo',
        color: '#000000',
        isUrgent: false,
        active: false,
      },
    );
    const ctx = new TenantContextService();
    create = new CreateScheduleBlockUseCase(repo, locations, staff, ctx);
    update = new UpdateScheduleBlockUseCase(repo, locations, staff, ctx);
    now = new Date('2026-11-10T14:00:00.000Z'); // 10:00 en Caracas
    list = new ListScheduleBlocksUseCase(
      repo,
      locations,
      staff,
      ctx,
      () => now,
    );
  });

  it('crea un reservado con sus tipos y su hora de liberación', async () => {
    const block = await create.execute(RESERVED, ADMIN);
    expect(block).toMatchObject({
      kind: ScheduleBlockKind.RESERVED,
      reservedForTypeIds: ['urg'],
      releaseAtMinute: 660,
      allowsBooking: false,
    });
  });

  it('un tipo de otra clínica (o inexistente) es 404', async () => {
    await expect(
      create.execute({ ...RESERVED, reservedForTypeIds: ['ajeno'] }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('un tipo desactivado es 400', async () => {
    await expect(
      create.execute({ ...RESERVED, reservedForTypeIds: ['off'] }, ADMIN),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sin tipos, sin sede o con liberación tras el inicio, 400', async () => {
    await expect(
      create.execute({ ...RESERVED, reservedForTypeIds: [] }, ADMIN),
    ).rejects.toThrow(/al menos un tipo/);
    await expect(
      create.execute({ ...RESERVED, locationId: undefined }, ADMIN),
    ).rejects.toThrow(/sede/);
    await expect(
      create.execute({ ...RESERVED, releaseAtMinute: 16 * 60 }, ADMIN),
    ).rejects.toThrow(/antes del inicio/);
  });

  it('un bloqueo normal no admite tipos reservados', async () => {
    await expect(
      create.execute(
        { ...RESERVED, kind: ScheduleBlockKind.MEETING, releaseAtMinute: null },
        ADMIN,
      ),
    ).rejects.toThrow(/Solo un bloque «Reservado»/);
  });

  it('pasar de reservado a otro tipo limpia tipos y liberación', async () => {
    const block = await create.execute(RESERVED, ADMIN);
    const changed = await update.execute(
      block.id,
      { kind: ScheduleBlockKind.MEETING },
      ADMIN,
    );
    expect(changed).toMatchObject({
      kind: ScheduleBlockKind.MEETING,
      reservedForTypeIds: [],
      releaseAtMinute: null,
    });
  });

  it('cambiar los tipos valida de nuevo la clínica', async () => {
    const block = await create.execute(RESERVED, ADMIN);
    await expect(
      update.execute(block.id, { reservedForTypeIds: ['ajeno'] }, ADMIN),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('el listado trae nombres, liberación y si ya se liberó (reloj inyectado)', async () => {
    await create.execute(RESERVED, ADMIN);
    const range = {
      from: new Date('2026-11-10T00:00:00.000Z'),
      to: new Date('2026-11-11T00:00:00.000Z'),
    };
    const [before] = await list.execute(range);
    expect(before).toMatchObject({
      reservedForTypes: [{ id: 'urg', name: 'Consulta de urgencia' }],
      released: false,
    });
    expect(before.releaseAt?.toISOString()).toBe('2026-11-10T15:00:00.000Z');

    now = new Date('2026-11-10T15:00:00.000Z'); // 11:00 en Caracas
    const [after] = await list.execute(range);
    expect(after.released).toBe(true);
  });
});
