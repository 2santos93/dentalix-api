import { ConflictException, Injectable } from '@nestjs/common';
import { Prisma, type PatientSourceKind } from '@prisma/client';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../audit/infrastructure/prisma-audit-event.repository';
import { configAuditEvent } from '../../audit/domain/config-audit';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CUSTOM_SOURCE_SORT_ORDER,
  PATIENT_SOURCE_MESSAGES,
  type PatientSourceEntity,
} from '../domain/patient-source';
import type {
  PatientAcquisitionView,
  PatientSourceRepository,
} from '../domain/patient-source-repository.port';

const SELECT = {
  id: true,
  name: true,
  kind: true,
  isActive: true,
  systemKey: true,
  sortOrder: true,
} as const satisfies Prisma.PatientSourceSelect;

/** Lo que entra en el evento de auditoría (antes/después). */
function snapshot(row: PatientSourceEntity): Record<string, string | boolean> {
  return { name: row.name, kind: row.kind, isActive: row.isActive };
}

/** Dos altas o renombres a la vez con el mismo nombre: el único lo decide. */
function rethrowDuplicateName(error: unknown): never {
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  ) {
    throw new ConflictException(PATIENT_SOURCE_MESSAGES.nameTaken);
  }
  throw error;
}

const fullName = (p: { firstName: string; lastName: string }): string =>
  `${p.firstName} ${p.lastName}`.trim();

/**
 * Catálogo «¿Cómo nos conoció?» (DX-172), con el tenant explícito además de la
 * RLS. Cada escritura deja su evento CLINIC_SETTINGS (antes/después) en su
 * misma transacción, como el resto de ajustes de la clínica (DX-360).
 */
@Injectable()
export class PrismaPatientSourceRepository implements PatientSourceRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private tenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return tenantId;
  }

  async list(includeInactive: boolean): Promise<PatientSourceEntity[]> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      // Una clínica sin ninguna (de antes del relleno o creada por otra vía)
      // recibe las de por defecto; con alguna, no hace nada.
      await tx.$queryRaw`SELECT public.dx_patient_sources_ensure(${tenantId}::uuid)`;
      return tx.patientSource.findMany({
        where: { tenantId, ...(includeInactive ? {} : { isActive: true }) },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { id: 'asc' }],
        select: SELECT,
      });
    });
  }

  async create(
    input: { name: string; kind: PatientSourceKind },
    audit: AuditRequestContext,
  ): Promise<PatientSourceEntity> {
    const tenantId = this.tenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        await tx.$queryRaw`SELECT public.dx_patient_sources_ensure(${tenantId}::uuid)`;
        const created = await tx.patientSource.create({
          data: {
            tenantId,
            name: input.name,
            kind: input.kind,
            sortOrder: CUSTOM_SOURCE_SORT_ORDER,
          },
          select: SELECT,
        });
        await writeAuditEvent(
          tx,
          configAuditEvent(audit, {
            action: 'CREATE',
            resourceType: 'CLINIC_SETTINGS',
            resourceId: created.id,
            reason: 'PATIENT_SOURCE_CREATED',
            after: snapshot(created),
          }),
        );
        return created;
      })
      .catch(rethrowDuplicateName);
  }

  async update(
    id: string,
    patch: { name?: string; isActive?: boolean },
    audit: AuditRequestContext,
  ): Promise<PatientSourceEntity | null> {
    const tenantId = this.tenantId();
    return this.prisma
      .runWithTenant(async (tx) => {
        const [locked] = await tx.$queryRaw<{ id: string }[]>`
          SELECT "id" FROM "patient_sources"
           WHERE "tenantId" = ${tenantId}::uuid AND "id" = ${id}::uuid
           FOR UPDATE`;
        if (!locked) return null;
        const before = await tx.patientSource.findUniqueOrThrow({
          where: { id },
          select: SELECT,
        });
        const after = await tx.patientSource.update({
          where: { id },
          data: {
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...(patch.isActive !== undefined
              ? { isActive: patch.isActive }
              : {}),
          },
          select: SELECT,
        });
        const event = configAuditEvent(audit, {
          action: 'UPDATE',
          resourceType: 'CLINIC_SETTINGS',
          resourceId: id,
          reason: 'PATIENT_SOURCE_UPDATED',
          before: snapshot(before),
          after: snapshot(after),
        });
        if (event) await writeAuditEvent(tx, event);
        return after;
      })
      .catch(rethrowDuplicateName);
  }

  /**
   * La captación de un paciente vivo y a quién recomendó: tres lecturas fijas
   * (el paciente con su fuente y su referente, el COUNT y los más recientes,
   * por `patients_tenant_referred_by_idx`), sin depender del número de
   * referidos. Solo cuenta a los referidos vivos.
   */
  async acquisition(
    patientId: string,
    recentLimit: number,
  ): Promise<PatientAcquisitionView | null> {
    const tenantId = this.tenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { tenantId, id: patientId, deletedAt: null },
        select: {
          referredByName: true,
          source: {
            select: { id: true, name: true, kind: true, isActive: true },
          },
          referredByPatient: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              patientCode: true,
            },
          },
        },
      });
      if (!patient) return null;
      const where = {
        tenantId,
        referredByPatientId: patientId,
        deletedAt: null,
      } satisfies Prisma.PatientWhereInput;
      const count = await tx.patient.count({ where });
      const recent = await tx.patient.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: recentLimit,
        select: { id: true, firstName: true, lastName: true, createdAt: true },
      });
      const referrer = patient.referredByPatient;
      return {
        source: patient.source,
        referredByPatient: referrer
          ? {
              id: referrer.id,
              fullName: fullName(referrer),
              patientCode: String(referrer.patientCode),
            }
          : null,
        referredByName: patient.referredByName,
        referrals: {
          count,
          recent: recent.map((r) => ({
            id: r.id,
            fullName: fullName(r),
            createdAt: r.createdAt,
          })),
        },
      };
    });
  }
}
