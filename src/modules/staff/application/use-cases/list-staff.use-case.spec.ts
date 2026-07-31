import { ClinicRole } from '@prisma/client';
import { ListStaffUseCase } from './list-staff.use-case';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { StaffRepository } from '../../domain/ports/staff-repository.port';

function makeRepo(overrides: Partial<StaffRepository> = {}): StaffRepository {
  return {
    listActive: (): Promise<StaffMember[]> => Promise.resolve([]),
    findUserByEmailGlobal: (): Promise<{ id: string } | null> =>
      Promise.resolve(null),
    create: (): Promise<StaffMember> =>
      Promise.reject(new Error('not implemented in this fake')),
    findById: (): Promise<StaffMember | null> => Promise.resolve(null),
    updateById: (): Promise<StaffMember | null> => Promise.resolve(null),
    deactivateById: (): Promise<boolean> => Promise.resolve(false),
    reactivateMembership: (): Promise<StaffMember | null> => Promise.resolve(null),
    countActiveOwners: (): Promise<number> => Promise.resolve(0),
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
        role: ClinicRole.OWNER,
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
