import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { LivePublicLinkCounts } from '../../domain/live-public-links';
import type { PatientPublicLinksReader } from '../../domain/ports/patient-public-links.port';
import { countLivePublicLinks } from '../patient-public-links';

/** DX-461: cuenta los enlaces públicos vivos del paciente (RLS FORCE). */
@Injectable()
export class PrismaPatientPublicLinksRepository implements PatientPublicLinksReader {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  countLive(
    patientId: string,
    now: Date,
  ): Promise<LivePublicLinkCounts | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant(async (tx) => {
      // Bajo RLS: un paciente de otra clínica no aparece (404 en la ruta).
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: { id: true },
      });
      if (!patient) return null;
      return countLivePublicLinks(tx, { tenantId, patientId, now });
    });
  }
}
