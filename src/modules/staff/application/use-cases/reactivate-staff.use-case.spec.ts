import { ClinicRole } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { ReactivateStaffUseCase } from './reactivate-staff.use-case';
import { GetStaffDetailUseCase } from './get-staff-detail.use-case';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import type {
  StaffRepository,
  DeactivateStaffOutcome,
  UpdateStaffOutcome,
} from '../../domain/ports/staff-repository.port';
import { StaffDirectoryPage } from '../../domain/entities/staff-directory-entry.entity';
import type { StaffLoginLocks } from '../../domain/ports/staff-login-locks.port';

function makeRepo(overrides: Partial<StaffRepository> = {}): StaffRepository {
  return {
    listActive: (): Promise<StaffMember[]> => Promise.resolve([]),
    listDirectory: (): Promise<StaffDirectoryPage> =>
      Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
    findById: (): Promise<StaffMember | null> => Promise.resolve(null),
    findDetailById: (): Promise<
      (StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null
    > => Promise.resolve(null),
    updateById: (): Promise<UpdateStaffOutcome> =>
      Promise.resolve({ kind: 'NOT_FOUND' }),
    deactivateById: (): Promise<DeactivateStaffOutcome> =>
      Promise.resolve('NOT_FOUND'),
    reactivateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    hasOtherActiveMemberships: (): Promise<boolean> => Promise.resolve(false),
    getLocations: () => Promise.resolve({ kind: 'NOT_FOUND' as const }),
    replaceLocations: () => Promise.resolve({ kind: 'NOT_FOUND' as const }),
    ...overrides,
  };
}

const noLocks: StaffLoginLocks = {
  blockedUntil: () => Promise.resolve(null),
  unlock: () => Promise.resolve(),
};

const miembro: StaffMember = {
  userId: 'u1',
  fullName: 'Ana Ríos',
  email: 'ana@clinic.com',
  role: ClinicRole.DENTIST,
};

describe('ReactivateStaffUseCase', () => {
  it('devuelve el miembro reactivado', async () => {
    const repo = makeRepo({ reactivateById: () => Promise.resolve(miembro) });
    await expect(
      new ReactivateStaffUseCase(repo).execute('u1'),
    ).resolves.toEqual(miembro);
  });

  it('404 cuando no hay ninguna membresía desactivada que reactivar', async () => {
    const repo = makeRepo({ reactivateById: () => Promise.resolve(null) });
    await expect(
      new ReactivateStaffUseCase(repo).execute('u1'),
    ).rejects.toThrow(NotFoundException);
  });

  it('no pasa por la regla del último ADMIN: reactivar suma acceso, nunca lo quita', async () => {
    let escritoConRegla = false;
    const repo = makeRepo({
      reactivateById: () => Promise.resolve(miembro),
      updateById: () => {
        escritoConRegla = true;
        return Promise.resolve({ kind: 'NOT_FOUND' });
      },
      deactivateById: () => {
        escritoConRegla = true;
        return Promise.resolve('NOT_FOUND');
      },
    });
    await new ReactivateStaffUseCase(repo).execute('u1');
    expect(escritoConRegla).toBe(false);
  });
});

describe('GetStaffDetailUseCase', () => {
  it('abre también el perfil de un desactivado (es donde se le reactiva)', async () => {
    const repo = makeRepo({
      findDetailById: () =>
        Promise.resolve({ ...miembro, status: 'INACTIVE' as const }),
      // `findById` solo ve activos: si el caso de uso lo usara, este perfil
      // daría 404 y no habría forma de reactivar a nadie desde la UI.
      findById: () => Promise.resolve(null),
    });
    await expect(
      new GetStaffDetailUseCase(repo, noLocks).execute('u1'),
    ).resolves.toEqual({
      ...miembro,
      status: 'INACTIVE',
      loginBlockedUntil: null,
    });
  });

  it('404 cuando no existe la persona en esta clínica', async () => {
    const repo = makeRepo({ findDetailById: () => Promise.resolve(null) });
    await expect(
      new GetStaffDetailUseCase(repo, noLocks).execute('u1'),
    ).rejects.toThrow(NotFoundException);
  });
});
