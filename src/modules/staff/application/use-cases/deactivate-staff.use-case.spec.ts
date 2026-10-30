import { DeactivateStaffUseCase } from './deactivate-staff.use-case';
import { NotFoundException, ConflictException } from '@nestjs/common';
import type {
  DeactivateStaffOutcome,
  StaffRepository,
} from '../../domain/ports/staff-repository.port';
import { ClinicRole } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

// DX-359: quién cambia el miembro; el repositorio escribe el evento en la
// misma transacción que el cambio.
const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'admin', role: ClinicRole.ADMIN },
  requestId: 'req-1',
  ip: null,
  userAgent: null,
};

// La regla "siempre queda al menos un ADMIN" la garantiza el repositorio de
// forma ATÓMICA (DX-042, DB-012): comprobación y escritura en una sola
// transacción. El caso de uso solo traduce el resultado.
const makeRepo = (outcome: DeactivateStaffOutcome = 'DEACTIVATED') => {
  const deactivateById = jest.fn().mockResolvedValue(outcome);
  return {
    repo: { deactivateById } as unknown as StaffRepository,
    deactivateById,
  };
};

it('desactiva un miembro', async () => {
  const { repo, deactivateById } = makeRepo();
  await new DeactivateStaffUseCase(repo).execute(
    {
      userId: 'u1',
      requestingUserId: 'admin',
    },
    CTX,
  );
  expect(deactivateById).toHaveBeenCalledWith('u1', CTX);
});

it('404 si no existe', async () => {
  const { repo } = makeRepo('NOT_FOUND');
  await expect(
    new DeactivateStaffUseCase(repo).execute(
      {
        userId: 'x',
        requestingUserId: 'a',
      },
      CTX,
    ),
  ).rejects.toBeInstanceOf(NotFoundException);
});

it('409 al desactivarte a ti mismo, sin tocar la base', async () => {
  const { repo, deactivateById } = makeRepo();
  await expect(
    new DeactivateStaffUseCase(repo).execute(
      {
        userId: 'u1',
        requestingUserId: 'u1',
      },
      CTX,
    ),
  ).rejects.toBeInstanceOf(ConflictException);
  expect(deactivateById).not.toHaveBeenCalled();
});

it('409 al desactivar al último ADMIN', async () => {
  const { repo } = makeRepo('LAST_ADMIN');
  await expect(
    new DeactivateStaffUseCase(repo).execute(
      {
        userId: 'u1',
        requestingUserId: 'admin',
      },
      CTX,
    ),
  ).rejects.toThrow(new ConflictException('Cannot deactivate the last admin'));
});
