import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, ExtraPermission } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  ReplaceExtraPermissionsOutcome,
  StaffRepository,
} from '../../domain/ports/staff-repository.port';
import {
  ADMIN_HAS_ALL_PERMISSIONS_MESSAGE,
  OWN_PERMISSIONS_MESSAGE,
  ReplaceStaffPermissionsUseCase,
} from './staff-permissions.use-cases';

const ADMIN_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const MEMBER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ctx = { tenantId: 't1' } as unknown as AuditRequestContext;

function makeUseCase(outcome: ReplaceExtraPermissionsOutcome) {
  const replaceExtraPermissions = jest.fn().mockResolvedValue(outcome);
  const repo = { replaceExtraPermissions } as unknown as StaffRepository;
  return {
    uc: new ReplaceStaffPermissionsUseCase(repo),
    replaceExtraPermissions,
  };
}

describe('ReplaceStaffPermissionsUseCase (DX-090)', () => {
  it('concede, normaliza (sin duplicados, orden del catálogo) y devuelve los efectivos', async () => {
    const { uc, replaceExtraPermissions } = makeUseCase({
      kind: 'UPDATED',
      role: ClinicRole.ASSISTANT,
      extraPermissions: [
        ExtraPermission.PAYMENT_REGISTER,
        ExtraPermission.FINANCIAL_REPORTS_VIEW,
      ],
    });
    const out = await uc.execute(
      {
        userId: MEMBER_ID,
        actorUserId: ADMIN_ID,
        permissions: [
          ExtraPermission.FINANCIAL_REPORTS_VIEW,
          ExtraPermission.PAYMENT_REGISTER,
          ExtraPermission.PAYMENT_REGISTER,
        ],
      },
      ctx,
    );
    expect(replaceExtraPermissions).toHaveBeenCalledWith(
      MEMBER_ID,
      [
        ExtraPermission.PAYMENT_REGISTER,
        ExtraPermission.FINANCIAL_REPORTS_VIEW,
      ],
      ctx,
    );
    expect(out).toEqual({
      extraPermissions: [
        ExtraPermission.PAYMENT_REGISTER,
        ExtraPermission.FINANCIAL_REPORTS_VIEW,
      ],
      effectivePermissions: [
        ExtraPermission.PAYMENT_REGISTER,
        ExtraPermission.FINANCIAL_REPORTS_VIEW,
      ],
    });
  });

  it('sin autoconcesión: 403 sobre los propios permisos (también con otra grafía del uuid) y no escribe', async () => {
    const { uc, replaceExtraPermissions } = makeUseCase({
      kind: 'NOT_FOUND',
    });
    await expect(
      uc.execute(
        {
          userId: ADMIN_ID.toUpperCase(),
          actorUserId: ADMIN_ID,
          permissions: [ExtraPermission.PAYMENT_REGISTER],
        },
        ctx,
      ),
    ).rejects.toThrow(new ForbiddenException(OWN_PERMISSIONS_MESSAGE));
    expect(replaceExtraPermissions).not.toHaveBeenCalled();
  });

  it('miembro inexistente o de otra clínica → 404', async () => {
    const { uc } = makeUseCase({ kind: 'NOT_FOUND' });
    await expect(
      uc.execute(
        { userId: MEMBER_ID, actorUserId: ADMIN_ID, permissions: [] },
        ctx,
      ),
    ).rejects.toThrow(NotFoundException);
  });

  it('a un ADMIN no se le conceden → 409', async () => {
    const { uc } = makeUseCase({ kind: 'IS_ADMIN' });
    await expect(
      uc.execute(
        { userId: MEMBER_ID, actorUserId: ADMIN_ID, permissions: [] },
        ctx,
      ),
    ).rejects.toThrow(new ConflictException(ADMIN_HAS_ALL_PERMISSIONS_MESSAGE));
  });
});
