import { ClinicRole } from '@prisma/client';
import { ListStaffUseCase } from './list-staff.use-case';
import { StaffMember } from '../../domain/entities/staff-member.entity';
import { StaffRepository } from '../../domain/ports/staff-repository.port';

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
    const repo: StaffRepository = {
      listActive: (): Promise<StaffMember[]> => Promise.resolve(members),
    };
    const uc = new ListStaffUseCase(repo);

    const result = await uc.execute();

    expect(result).toBe(members);
    expect(result[0].email).toBe('ana@clinic.com');
  });
});
