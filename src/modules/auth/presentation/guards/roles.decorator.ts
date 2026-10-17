import { SetMetadata } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: ClinicRole[]) => SetMetadata(ROLES_KEY, roles);

export const ROLES_DENIED_MESSAGE_KEY = 'rolesDeniedMessage';
/**
 * Mensaje del 403 de RolesGuard para la ruta (o el controlador), en español
 * para quien lo lee en la web. Sin él, el genérico «Insufficient role».
 */
export const RolesDeniedMessage = (message: string) =>
  SetMetadata(ROLES_DENIED_MESSAGE_KEY, message);
