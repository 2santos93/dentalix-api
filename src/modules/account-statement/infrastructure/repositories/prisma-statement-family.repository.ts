import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  loadNoticeLocation,
  loadNoticeResponsibles,
} from '../../../patients/infrastructure/notices/notice-context';
import type {
  StatementFamily,
  StatementFamilyRepository,
  StatementNoticeData,
} from '../../domain/ports/statement-family-repository.port';

/**
 * Destinatario del estado de cuenta y familia del pagador (DX-203), bajo la
 * RLS de la clínica del contexto. Solo nombres y parentesco: nada clínico de
 * los otros miembros.
 */
@Injectable()
export class PrismaStatementFamilyRepository implements StatementFamilyRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  loadNotice(patientId: string): Promise<StatementNoticeData | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          firstName: true,
          birthDate: true,
          email: true,
          emergencyContactName: true,
        },
      });
      if (!patient) return null;
      const [responsibles, location] = await Promise.all([
        loadNoticeResponsibles(tx, patientId),
        loadNoticeLocation(
          tx,
          tenantId,
          this.tenantContext.getLocationId() ?? null,
        ),
      ]);
      return { patient, responsibles, location };
    });
  }

  loadFamily(payerPatientId: string): Promise<StatementFamily | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const payer = await tx.patient.findFirst({
        where: { id: payerPatientId, deletedAt: null },
        select: { id: true, firstName: true, lastName: true },
      });
      if (!payer) return null;
      // Índice parcial patient_responsible_parties_responsible_idx.
      const links = await tx.patientResponsibleParty.findMany({
        where: {
          responsiblePatientId: payerPatientId,
          isPayer: true,
          deletedAt: null,
          patient: { deletedAt: null },
        },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          relationship: true,
          patient: { select: { id: true, firstName: true, lastName: true } },
        },
      });
      return {
        payer: { ...payer, relationship: null },
        dependents: links.map((l) => ({
          ...l.patient,
          relationship: l.relationship,
        })),
      };
    });
  }
}
