import { SetMetadata } from '@nestjs/common';
import type { ExtraPermission } from '@prisma/client';

export const ALLOW_PERMISSIONS_KEY = 'allowPermissions';

/**
 * DX-090: la ruta admite, ADEMÁS de los roles de su `@Roles(...)`, a quien
 * tenga concedido alguno de estos permisos extra (rol base O permiso). Lo
 * aplica `RolesGuard`.
 *
 * SOLO a nivel de método, a propósito: `RolesGuard` lo lee del handler, nunca
 * de la clase. Así un permiso no se cuela en una ruta hermana que no lo
 * declara (anular un abono, reabrir una caja), aunque comparta controlador.
 */
export const AllowPermissions = (
  ...permissions: ExtraPermission[]
): MethodDecorator => SetMetadata(ALLOW_PERMISSIONS_KEY, permissions);
