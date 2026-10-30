import { BadRequestException } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { UpdateMyNameUseCase } from './update-my-name.use-case';
import { UserProfileRepository } from '../../domain/ports/user-profile-repository.port';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

// DX-359: la sesión de clínica de quien cambia su nombre.
const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'u1', role: ClinicRole.DENTIST },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

describe('UpdateMyNameUseCase', () => {
  it('trims and persists the name', async () => {
    let saved: { userId: string; fullName: string } | null = null;
    const repo = {
      updateName: (userId: string, fullName: string) => {
        saved = { userId, fullName };
        return Promise.resolve();
      },
    } as unknown as UserProfileRepository;
    await new UpdateMyNameUseCase(repo).execute(
      { userId: 'u1', fullName: '  Ana Gómez  ' },
      CTX,
    );
    expect(saved).toEqual({ userId: 'u1', fullName: 'Ana Gómez' });
  });

  it('DX-359: pasa al repositorio el evento (campo cambiado, nunca el nombre)', async () => {
    const updateName = jest.fn().mockResolvedValue(undefined);
    const repo = { updateName } as unknown as UserProfileRepository;
    await new UpdateMyNameUseCase(repo).execute(
      { userId: 'u1', fullName: 'Ana Gómez' },
      CTX,
    );
    expect(updateName).toHaveBeenCalledWith('u1', 'Ana Gómez', {
      tenantId: 't1',
      locationId: null,
      actor: { kind: 'user', userId: 'u1', role: ClinicRole.DENTIST },
      patient: null,
      requestId: 'req-1',
      ip: null,
      userAgent: null,
      action: 'UPDATE',
      resourceType: 'STAFF_MEMBER',
      resourceId: 'u1',
      metadata: { reason: 'OWN_NAME_CHANGED', changedFields: ['fullName'] },
    });
  });

  it('rejects an empty name', async () => {
    const repo = {
      updateName: async () => {},
    } as unknown as UserProfileRepository;
    await expect(
      new UpdateMyNameUseCase(repo).execute(
        { userId: 'u1', fullName: '   ' },
        CTX,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
