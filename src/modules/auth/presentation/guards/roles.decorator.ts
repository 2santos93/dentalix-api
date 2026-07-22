import { SetMetadata } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: ClinicRole[]) => SetMetadata(ROLES_KEY, roles);
