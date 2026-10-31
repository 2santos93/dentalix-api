import { ConflictException, Injectable } from '@nestjs/common';
import { AppointmentStatus, ReservedOverrideKind, Sex } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  DOC_TAKEN_MESSAGE,
  insertPatientRowInTx,
} from '../../../patients/infrastructure/repositories/prisma-patient.repository';
import { PATIENT_DUPLICATE_CODE } from '../../domain/walk-in';
import type {
  WalkInRepository,
  WalkInWrite,
  WalkInWriteResult,
} from '../../domain/ports/walk-in-repository.port';
import {
  INCLUDE_PATIENT_NAME,
  mapToEntity,
} from './prisma-appointment.repository';

/** Códigos de auditoría de «Atender sin cita» (DX-470). */
export const WALK_IN_AUDIT_REASONS = {
  patient: 'WALK_IN_PATIENT',
  arrival: 'WALK_IN_ARRIVAL',
  overbook: 'WALK_IN_OVERBOOK',
} as const;

/**
 * «Atender sin cita» (DX-470) en UNA transacción con `app.current_tenant`:
 * alta mínima (si el paciente es nuevo), cita ARRIVED, motivo del sobrecupo
 * y sus `audit_event`. Si algo falla (documento repetido, solape por una
 * carrera en la EXCLUDE, FK compuesta), no queda nada.
 */
@Injectable()
export class PrismaWalkInRepository implements WalkInRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  async create(
    input: WalkInWrite,
    ctx: AuditRequestContext,
  ): Promise<WalkInWriteResult> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    const actor = {
      kind: 'user' as const,
      userId: ctx.actor.userId,
      role: ctx.actor.role,
    };
    const trace = {
      tenantId,
      locationId: input.locationId,
      actor,
      requestId: ctx.requestId,
      ip: ctx.ip,
      userAgent: ctx.userAgent,
    };

    return this.prisma.runWithTenant(async (tx) => {
      let patientId: string;
      let patientCreated = false;
      if (input.patient.kind === 'new') {
        const data = input.patient.data;
        const created = await insertPatientRowInTx(
          tx,
          tenantId,
          {
            firstName: data.firstName,
            lastName: data.lastName,
            phone: data.phone,
            docType: data.docType,
            docTypeLabel: data.docTypeLabel,
            docNumber: data.docNumber,
            sex: Sex.UNSPECIFIED,
            createdById: input.createdById,
          },
          (existingPatientId) =>
            new ConflictException({
              statusCode: 409,
              error: 'Conflict',
              code: PATIENT_DUPLICATE_CODE,
              message: DOC_TAKEN_MESSAGE,
              existingPatientId,
            }),
        );
        patientId = created.id;
        patientCreated = true;
        await writeAuditEvent(tx, {
          ...trace,
          action: 'CREATE',
          resourceType: 'PATIENT',
          resourceId: patientId,
          patient: { kind: 'patient', id: patientId },
          metadata: {
            reason: WALK_IN_AUDIT_REASONS.patient,
            changedFields: [
              'firstName',
              'lastName',
              'phone',
              ...(data.docNumber ? ['docType', 'docNumber'] : []),
            ],
          },
        });
      } else {
        patientId = input.patient.id;
      }

      // FK compuestas (tenantId, patientId) / (tenantId, locationId) /
      // (tenantId, appointmentTypeId): nada de otra clínica entra aunque un
      // id se colara. La EXCLUDE por profesional no cuenta un sobrecupo.
      const appointment = await tx.appointment.create({
        data: {
          tenantId,
          locationId: input.locationId,
          patientId,
          providerId: input.providerId,
          appointmentTypeId: input.appointmentTypeId,
          start: input.start,
          end: input.end,
          status: AppointmentStatus.ARRIVED,
          preArrivalStatus: AppointmentStatus.SCHEDULED,
          arrivedAt: input.arrivedAt,
          createdById: input.createdById,
          walkIn: true,
          overbooked: input.overbookReason !== null,
          triageFlags: input.triageFlags,
          triageNote: input.triageNote,
        },
        include: INCLUDE_PATIENT_NAME,
      });

      // Sin las señales ni la nota: solo los nombres de campo (DX-009).
      await writeAuditEvent(tx, {
        ...trace,
        action: 'CREATE',
        resourceType: 'APPOINTMENT',
        resourceId: appointment.id,
        patient: { kind: 'patient', id: patientId },
        metadata: {
          reason: WALK_IN_AUDIT_REASONS.arrival,
          status: {
            from: AppointmentStatus.SCHEDULED,
            to: AppointmentStatus.ARRIVED,
          },
          changedFields: [
            'providerId',
            'appointmentTypeId',
            ...(input.triageFlags.length > 0 ? ['triageFlags'] : []),
            ...(input.triageNote !== null ? ['triageNote'] : []),
          ],
        },
      });

      let overbookId: string | null = null;
      if (input.overbookReason !== null) {
        // El motivo, como el «Agendar igualmente» de DX-446: en su tabla
        // append-only, nunca en audit_event (que solo lleva el id).
        const saved = await tx.appointmentReservedOverride.create({
          data: {
            tenantId,
            patientId,
            appointmentId: appointment.id,
            kind: ReservedOverrideKind.WALK_IN_OVERBOOK,
            blockIds: [],
            reason: input.overbookReason,
            createdById: input.createdById,
          },
          select: { id: true },
        });
        overbookId = saved.id;
        await writeAuditEvent(tx, {
          ...trace,
          action: 'UPDATE',
          resourceType: 'APPOINTMENT',
          resourceId: appointment.id,
          patient: { kind: 'patient', id: patientId },
          metadata: {
            reason: WALK_IN_AUDIT_REASONS.overbook,
            params: { overrideId: saved.id },
          },
        });
      }

      return {
        appointment: mapToEntity(appointment),
        patientCreated,
        overbookId,
      };
    });
  }
}
