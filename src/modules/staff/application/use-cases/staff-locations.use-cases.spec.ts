import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import type {
  ReplaceLocationsOutcome,
  StaffLocationsLookup,
  StaffPatch,
  StaffRepository,
  UpdateStaffOutcome,
} from '../../domain/ports/staff-repository.port';
import {
  ADMIN_HAS_ALL_LOCATIONS_MESSAGE,
  GetStaffLocationsUseCase,
  ReplaceStaffLocationsUseCase,
  STAFF_MEMBER_NOT_FOUND_MESSAGE,
  UNKNOWN_LOCATION_MESSAGE,
} from './staff-locations.use-cases';
import { UpdateStaffUseCase } from './update-staff.use-case';

const A1 = '11111111-1111-4111-8111-111111111111';
const A2 = '22222222-2222-4222-8222-222222222222';
const INACTIVE = '33333333-3333-4333-8333-333333333333';
const ACTOR = 'admin-1';

/**
 * Repositorio en memoria con la misma semántica que el de Prisma: sin filas =
 * todas las sedes; solo se aceptan sedes activas de la clínica; un ADMIN no se
 * restringe; ascender a ADMIN borra sus filas.
 */
class InMemoryStaffRepository {
  readonly members = new Map<string, { role: ClinicRole; active: boolean }>();
  readonly rows = new Map<string, string[]>();
  readonly activeLocations = new Set([A1, A2]);
  writes = 0;

  getLocations(userId: string): Promise<StaffLocationsLookup> {
    if (!this.members.has(userId))
      return Promise.resolve({ kind: 'NOT_FOUND' });
    const rows = this.rows.get(userId) ?? [];
    return Promise.resolve({
      kind: 'FOUND',
      locationIds:
        rows.length === 0
          ? null
          : rows.filter((id) => this.activeLocations.has(id)),
    });
  }

  replaceLocations(
    userId: string,
    locationIds: string[],
  ): Promise<ReplaceLocationsOutcome> {
    const member = this.members.get(userId);
    if (!member?.active) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (member.role === ClinicRole.ADMIN)
      return Promise.resolve({ kind: 'IS_ADMIN' });
    if (locationIds.some((id) => !this.activeLocations.has(id)))
      return Promise.resolve({ kind: 'UNKNOWN_LOCATION' });
    this.writes++;
    this.rows.set(userId, [...locationIds]);
    return Promise.resolve({ kind: 'UPDATED', locationIds });
  }

  updateById(userId: string, patch: StaffPatch): Promise<UpdateStaffOutcome> {
    const member = this.members.get(userId);
    if (!member?.active) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (patch.role) member.role = patch.role;
    if (patch.role === ClinicRole.ADMIN) this.rows.delete(userId);
    return Promise.resolve({
      kind: 'UPDATED',
      member: { userId, fullName: 'R', email: 'r@a.com', role: member.role },
    });
  }
}

function setup() {
  const repo = new InMemoryStaffRepository();
  repo.members.set('admin-1', { role: ClinicRole.ADMIN, active: true });
  repo.members.set('rec-1', { role: ClinicRole.RECEPTION, active: true });
  const port = repo as unknown as StaffRepository;
  return {
    repo,
    get: new GetStaffLocationsUseCase(port),
    replace: new ReplaceStaffLocationsUseCase(port),
    update: new UpdateStaffUseCase(port),
  };
}

describe('sedes permitidas de un miembro (DX-089)', () => {
  it('sin restricción el miembro tiene todas las sedes', async () => {
    const { get } = setup();
    await expect(get.execute('rec-1')).resolves.toEqual({
      all: true,
      locationIds: [],
    });
  });

  it('restringe a las sedes pedidas, sin duplicados, y el GET lo refleja', async () => {
    const { get, replace, repo } = setup();
    await expect(
      replace.execute({
        userId: 'rec-1',
        locationIds: [A1, A1],
        actorUserId: ACTOR,
      }),
    ).resolves.toEqual({ all: false, locationIds: [A1] });
    expect(repo.rows.get('rec-1')).toEqual([A1]);
    await expect(get.execute('rec-1')).resolves.toEqual({
      all: false,
      locationIds: [A1],
    });
  });

  it('quita duplicados aunque vengan en otra caja (Postgres no la distingue)', async () => {
    const { replace, repo } = setup();
    const spy = jest.spyOn(repo, 'replaceLocations');
    await expect(
      replace.execute({
        userId: 'rec-1',
        locationIds: [A1.toUpperCase(), A1],
        actorUserId: ACTOR,
      }),
    ).resolves.toEqual({ all: false, locationIds: [A1] });
    expect(spy).toHaveBeenCalledWith('rec-1', [A1], ACTOR);
  });

  it('[] vuelve a dar todas las sedes', async () => {
    const { get, replace } = setup();
    await replace.execute({
      userId: 'rec-1',
      locationIds: [A1],
      actorUserId: ACTOR,
    });
    await expect(
      replace.execute({ userId: 'rec-1', locationIds: [], actorUserId: ACTOR }),
    ).resolves.toEqual({ all: true, locationIds: [] });
    await expect(get.execute('rec-1')).resolves.toEqual({
      all: true,
      locationIds: [],
    });
  });

  it('un ADMIN no se puede restringir (409)', async () => {
    const { replace, repo } = setup();
    await expect(
      replace.execute({
        userId: 'admin-1',
        locationIds: [A1],
        actorUserId: ACTOR,
      }),
    ).rejects.toThrow(new ConflictException(ADMIN_HAS_ALL_LOCATIONS_MESSAGE));
    expect(repo.writes).toBe(0);
  });

  it('una sede desconocida o inactiva da 400 y no escribe nada', async () => {
    const { replace, repo } = setup();
    await expect(
      replace.execute({
        userId: 'rec-1',
        locationIds: [A1, INACTIVE],
        actorUserId: ACTOR,
      }),
    ).rejects.toThrow(new BadRequestException(UNKNOWN_LOCATION_MESSAGE));
    expect(repo.writes).toBe(0);
    expect(repo.rows.has('rec-1')).toBe(false);
  });

  it('miembro inexistente: 404 en el GET y en el PUT', async () => {
    const { get, replace } = setup();
    await expect(get.execute('nadie')).rejects.toThrow(
      new NotFoundException(STAFF_MEMBER_NOT_FOUND_MESSAGE),
    );
    await expect(
      replace.execute({ userId: 'nadie', locationIds: [], actorUserId: ACTOR }),
    ).rejects.toThrow(new NotFoundException(STAFF_MEMBER_NOT_FOUND_MESSAGE));
  });

  it('pasa al repositorio quién hace el cambio', async () => {
    const { replace, repo } = setup();
    const spy = jest.spyOn(repo, 'replaceLocations');
    await replace.execute({
      userId: 'rec-1',
      locationIds: [A2],
      actorUserId: ACTOR,
    });
    expect(spy).toHaveBeenCalledWith('rec-1', [A2], ACTOR);
  });

  it('ascender a ADMIN le devuelve todas las sedes', async () => {
    const { get, replace, update } = setup();
    await replace.execute({
      userId: 'rec-1',
      locationIds: [A1],
      actorUserId: ACTOR,
    });
    await update.execute(
      { userId: 'rec-1', role: ClinicRole.ADMIN },
      {
        tenantId: 't1',
        locationId: null,
        actor: { userId: ACTOR, role: ClinicRole.ADMIN },
        requestId: null,
        ip: null,
        userAgent: null,
      },
    );
    await expect(get.execute('rec-1')).resolves.toEqual({
      all: true,
      locationIds: [],
    });
  });

  it('si todas sus sedes se desactivan queda sin ninguna, no con todas', async () => {
    const { get, replace, repo } = setup();
    await replace.execute({
      userId: 'rec-1',
      locationIds: [A1],
      actorUserId: ACTOR,
    });
    repo.activeLocations.delete(A1);
    await expect(get.execute('rec-1')).resolves.toEqual({
      all: false,
      locationIds: [],
    });
  });
});
