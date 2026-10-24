import { NotFoundException } from '@nestjs/common';
import type {
  AppointmentConfirmationRepository,
  ConfirmationLookup,
} from '../domain/ports/appointment-confirmation-repository.port';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  hashConfirmationToken,
  isWellFormedConfirmationToken,
} from './confirmation-token';

/** 404 del enlace público: inventado, caducado o de otra clínica (igual). */
export const CONFIRMATION_LINK_NOT_FOUND_MESSAGE =
  'El enlace de confirmación no existe o ya no es válido.';

/**
 * Búsqueda común de GET y POST públicos. El tenant sale SOLO del host (no hay
 * JWT): sin tenant en contexto no hay nada que buscar, y se comprueba ANTES de
 * tocar el repo para no llegar al "No tenant in context" de `runWithTenant`
 * (que Nest serviría como 500). La RLS hace el resto: un token de la clínica
 * A usado en el host de la clínica B no encuentra fila → mismo 404 que un
 * token inventado, sin distinguir "existe en otra clínica".
 */
export async function findConfirmationByToken(
  tenantContext: TenantContextService,
  repo: AppointmentConfirmationRepository,
  token: string,
): Promise<ConfirmationLookup> {
  if (!tenantContext.getTenantId() || !isWellFormedConfirmationToken(token)) {
    throw new NotFoundException(CONFIRMATION_LINK_NOT_FOUND_MESSAGE);
  }
  const found = await repo.findByTokenHash(hashConfirmationToken(token));
  if (!found) {
    throw new NotFoundException(CONFIRMATION_LINK_NOT_FOUND_MESSAGE);
  }
  return found;
}
