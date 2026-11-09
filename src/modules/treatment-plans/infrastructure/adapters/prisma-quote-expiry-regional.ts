import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { isValidTimeZone } from '../../../../shared/time/civil-day';
import type {
  QuoteExpiryRegional,
  QuoteExpiryRegionalReader,
} from '../../domain/ports/quote-expiry-regional.port';

/**
 * DX-379 (C): la sede del vencimiento del presupuesto de un plan (la de su
 * presentación o la de escritura del request), bajo la RLS de la clínica.
 * Tolerante: una sede sin zona válida da `timeZone: null` y decide quien la
 * usa.
 */
@Injectable()
export class PrismaQuoteExpiryRegional implements QuoteExpiryRegionalReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  forPlan(planId: string): Promise<QuoteExpiryRegional | null> {
    return this.prisma.runWithTenant(
      async (tx) => {
        const plan = await tx.treatmentPlan.findFirst({
          where: { id: planId, deletedAt: null },
          select: { presentedLocationId: true },
        });
        if (!plan) return null;
        const locationId =
          plan.presentedLocationId ??
          (await this.tenantContext.writeLocationId(tx));
        const location = await tx.location.findFirst({
          where: { id: locationId },
          select: { timeZone: true, locale: true, hourCycle: true },
        });
        const zone = location?.timeZone ?? null;
        return {
          presentedLocationId: plan.presentedLocationId,
          locationId,
          timeZone: zone && isValidTimeZone(zone) ? zone : null,
          locale: location?.locale ?? null,
          hourCycle: location?.hourCycle ?? null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
