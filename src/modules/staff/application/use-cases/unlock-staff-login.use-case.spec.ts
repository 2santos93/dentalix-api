import { ClinicRole } from '@prisma/client';
import { NotFoundException } from '@nestjs/common';
import { UnlockStaffLoginUseCase } from './unlock-staff-login.use-case';
import { GetStaffDetailUseCase } from './get-staff-detail.use-case';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import type { StaffLoginLocks } from '../../domain/ports/staff-login-locks.port';
import type { StaffMember } from '../../domain/entities/staff-member.entity';

const doctora: StaffMember & { status: 'ACTIVE' } = {
  userId: 'u1',
  fullName: 'Ana Ríos',
  email: 'ana@clinic.com',
  role: ClinicRole.DENTIST,
  status: 'ACTIVE',
};

function setup(member: typeof doctora | null, blockedUntil: Date | null) {
  const findDetailById = jest.fn().mockResolvedValue(member);
  const repo = { findDetailById } as unknown as StaffRepository;
  const unlock = jest.fn().mockResolvedValue(undefined);
  const blocked = jest.fn().mockResolvedValue(blockedUntil);
  const locks: StaffLoginLocks = { blockedUntil: blocked, unlock };
  return { repo, locks, findDetailById, unlock, blocked };
}

describe('UnlockStaffLoginUseCase (DX-048)', () => {
  it('desbloquea por el email del miembro de ESTA clínica', async () => {
    const { repo, locks, findDetailById, unlock } = setup(doctora, new Date());
    await new UnlockStaffLoginUseCase(repo, locks).execute('u1');
    expect(findDetailById).toHaveBeenCalledWith('u1');
    expect(unlock).toHaveBeenCalledWith('ana@clinic.com');
  });

  it('404 si no es miembro de la clínica (otra clínica o inexistente), sin tocar contadores', async () => {
    const { repo, locks, unlock } = setup(null, null);
    await expect(
      new UnlockStaffLoginUseCase(repo, locks).execute('u-otra'),
    ).rejects.toThrow(NotFoundException);
    expect(unlock).not.toHaveBeenCalled();
  });

  it('es idempotente: desbloquear a quien no está bloqueado no falla', async () => {
    const { repo, locks } = setup(doctora, null);
    await expect(
      new UnlockStaffLoginUseCase(repo, locks).execute('u1'),
    ).resolves.toBeUndefined();
  });
});

describe('GetStaffDetailUseCase: estado del bloqueo (DX-048)', () => {
  it('incluye hasta cuándo está bloqueado el inicio de sesión', async () => {
    const until = new Date('2026-10-16T10:15:00Z');
    const { repo, locks, blocked } = setup(doctora, until);
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).resolves.toEqual({ ...doctora, loginBlockedUntil: until });
    expect(blocked).toHaveBeenCalledWith('ana@clinic.com');
  });

  it('null si no está bloqueado', async () => {
    const { repo, locks } = setup(doctora, null);
    await expect(
      new GetStaffDetailUseCase(repo, locks).execute('u1'),
    ).resolves.toEqual({ ...doctora, loginBlockedUntil: null });
  });
});
