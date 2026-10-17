import { ClinicRole } from '@prisma/client';
import { ListStaffUseCase } from './list-staff.use-case';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import type {
  StaffRepository,
  DeactivateStaffOutcome,
  UpdateStaffOutcome,
} from '../../domain/ports/staff-repository.port';
import { StaffDirectoryPage } from '../../domain/entities/staff-directory-entry.entity';

function makeRepo(overrides: Partial<StaffRepository> = {}): StaffRepository {
  return {
    listActive: (): Promise<StaffMember[]> => Promise.resolve([]),
    findById: (): Promise<StaffMember | null> => Promise.resolve(null),
    updateById: (): Promise<UpdateStaffOutcome> =>
      Promise.resolve({ kind: 'NOT_FOUND' }),
    deactivateById: (): Promise<DeactivateStaffOutcome> =>
      Promise.resolve('NOT_FOUND'),
    listDirectory: (): Promise<StaffDirectoryPage> =>
      Promise.resolve({ items: [], total: 0, page: 1, pageSize: 20 }),
    findDetailById: (): Promise<
      (StaffMember & { status: 'ACTIVE' | 'INACTIVE' }) | null
    > => Promise.resolve(null),
    reactivateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    hasOtherActiveMemberships: (): Promise<boolean> => Promise.resolve(false),
    ...overrides,
  };
}

describe('ListStaffUseCase', () => {
  it('returns whatever the repository resolves, untouched', async () => {
    const members: StaffMember[] = [
      {
        userId: 'u1',
        fullName: 'Dr. Owner',
        email: 'ana@clinic.com',
        role: ClinicRole.ADMIN,
      },
      {
        userId: 'u2',
        fullName: 'Recepcion Uno',
        email: 'recepcion@clinic.com',
        role: ClinicRole.RECEPTION,
      },
    ];
    const repo = makeRepo({
      listActive: (): Promise<StaffMember[]> => Promise.resolve(members),
    });
    const uc = new ListStaffUseCase(repo);

    const result = await uc.execute();

    expect(result).toBe(members);
    expect(result[0].email).toBe('ana@clinic.com');
  });
});
