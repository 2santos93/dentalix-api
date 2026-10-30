import { BadRequestException } from '@nestjs/common';
import type { PrismaService } from '../prisma/prisma.service';
import { locationNotAllowed } from './location-access';

/**
 * Sede activa de una petición de clínica: cabecera `X-Location-Id`, VALIDADA
 * contra la clínica (una sede de otra clínica no se ignora en silencio: eso
 * devolvería datos de la sede equivocada sin avisar; se rechaza) y contra las
 * sedes permitidas del token (DX-089, claim `loc`). Sin cabecera, quien solo
 * puede trabajar en UNA sede trabaja en ella (auto-pin); si no, `undefined`
 * (vista consolidada de toda la clínica).
 *
 * La usa `TenantContextInterceptor` y, DX-359, `/me`, que no pasa por él
 * (también sirve a tokens de plataforma) pero audita en la sede del actor.
 */
export async function resolveActiveLocationId(
  prisma: PrismaService,
  headers: Record<string, string | string[] | undefined> | undefined,
  tenantId: string,
  allowed: readonly string[] | undefined,
): Promise<string | undefined> {
  const raw = headers?.['x-location-id'] ?? undefined;
  const headerLocationId = Array.isArray(raw) ? raw[0] : raw;
  if (headerLocationId) {
    const location = await prisma.runWithTenant(tenantId, (tx) =>
      tx.location.findFirst({
        where: { id: headerLocationId, deletedAt: null },
        select: { id: true },
      }),
    );
    if (!location) {
      throw new BadRequestException('Unknown location for this clinic');
    }
    if (allowed && !allowed.includes(location.id)) {
      throw locationNotAllowed();
    }
    return location.id;
  }
  return allowed?.length === 1 ? allowed[0] : undefined;
}
