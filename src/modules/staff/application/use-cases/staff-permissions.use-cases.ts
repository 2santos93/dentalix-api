import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ExtraPermission } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  effectivePermissions,
  normalizeExtraPermissions,
} from '../../../auth/domain/extra-permissions';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import { STAFF_MEMBER_NOT_FOUND_MESSAGE } from './staff-locations.use-cases';

export const OWN_PERMISSIONS_MESSAGE =
  'No puedes cambiar tus propios permisos: pídeselo a otro administrador.';
export const ADMIN_HAS_ALL_PERMISSIONS_MESSAGE =
  'El ADMIN ya tiene todos los permisos: no se le conceden extra.';

/** DX-090: permisos extra de un miembro y lo que puede hacer en total. */
export interface StaffPermissions {
  extraPermissions: ExtraPermission[];
  effectivePermissions: ExtraPermission[];
}

export interface ReplaceStaffPermissionsInput {
  userId: string;
  permissions: ExtraPermission[];
  actorUserId: string;
}

/**
 * DX-090: `PUT /staff/:userId/permissions`. Sustituye los permisos extra del
 * miembro ACTIVO `userId` de esta clínica (la RLS acota: el de otra clínica es
 * 404). Nadie cambia los suyos (403), ni siquiera un ADMIN: un ADMIN no se
 * los necesita y otro rol no llega aquí, pero la regla queda explícita. Al
 * ADMIN no se le conceden (409): ya los tiene todos de serie. Auditado en la
 * transacción (PERMISSIONS_CHANGED con el antes y el después).
 */
@Injectable()
export class ReplaceStaffPermissionsUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  async execute(
    input: ReplaceStaffPermissionsInput,
    audit: AuditRequestContext,
  ): Promise<StaffPermissions> {
    if (input.userId.toLowerCase() === input.actorUserId.toLowerCase()) {
      throw new ForbiddenException(OWN_PERMISSIONS_MESSAGE);
    }
    const outcome = await this.repo.replaceExtraPermissions(
      input.userId,
      normalizeExtraPermissions(input.permissions),
      audit,
    );
    switch (outcome.kind) {
      case 'NOT_FOUND':
        throw new NotFoundException(STAFF_MEMBER_NOT_FOUND_MESSAGE);
      case 'IS_ADMIN':
        throw new ConflictException(ADMIN_HAS_ALL_PERMISSIONS_MESSAGE);
      case 'UPDATED':
        return {
          extraPermissions: outcome.extraPermissions,
          effectivePermissions: effectivePermissions(
            outcome.role,
            outcome.extraPermissions,
          ),
        };
    }
  }
}
