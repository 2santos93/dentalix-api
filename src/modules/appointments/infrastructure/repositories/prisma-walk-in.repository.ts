import { ConflictException, Injectable } from '@nestjs/common';
import {
  AppointmentStatus,
  Prisma,
  ReservedOverrideKind,
  Sex,
} from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { writeAuditEvent } from '../../../audit/infrastructure/prisma-audit-event.repository';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  DOC_TAKEN_MESSAGE,
  insertPatientRowInTx,
} from '../../../patients/infrastructure/repositories/prisma-patient.repository';
import { livePatientWithDoc } from '../../../patients/infrastructure/patient-doc-lock';
import { PATIENT_DUPLICATE_CODE } from '../../domain/walk-in';
import type {
  WalkInCreateOutcome,
  WalkInReplay,
  WalkInRepository,
  WalkInWrite,
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

  async findLivePatientIdByDoc(docNumber: string): Promise<string | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant((tx) =>
      livePatientWithDoc(tx, tenantId, docNumber),
    );
  }

  findByIdempotencyKey(key: string): Promise<WalkInReplay | null> {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) throw new Error('No tenant in context');
    return this.prisma.runWithTenant((tx) => replayIn(tx, tenantId, key));
  }

  async create(
    input: WalkInWrite,
    ctx: AuditRequestContext,
  ): Promise<WalkInCreateOutcome> {
    try {
      return await this.write(input, ctx);
    } catch (error) {
      // DX-510: red por si dos transacciones con la misma clave llegaran a
      // insertar (el candado de abajo lo evita): el único parcial rechaza la
      // segunda y se devuelve la original.
      const key = input.idempotency?.key;
      if (key && isUniqueViolation(error)) {
        const original = await this.findByIdempotencyKey(key);
        if (original) return { replayed: true, ...original };
      }
      throw error;
    }
  }

  private async write(
    input: WalkInWrite,
    ctx: AuditRequestContext,
  ): Promise<WalkInCreateOutcome> {
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
      const idempotency = input.idempotency;
      if (idempotency) {
        // DX-510: el doble clic o el reintento con la misma clave espera aquí
        // a la primera petición; si esa ya creó la cita, se devuelve (sin un
        // segundo paciente ni una segunda cita, y sin volver a auditar).
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(
          hashtext('dx_walk_in_idempotency:' || ${tenantId}),
          hashtext(${idempotency.key})
        )`;
        const original = await replayIn(tx, tenantId, idempotency.key);
        if (original) return { replayed: true as const, ...original };
      }
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
          idempotencyKey: idempotency?.key ?? null,
          idempotencyFingerprint: idempotency?.fingerprint ?? null,
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
        replayed: false as const,
        appointment: mapToEntity(appointment),
        patientCreated,
        overbookId,
      };
    });
  }
}

/** ¿Es un P2002 (violación de único)? Como en los gastos (DX-274). */
function isUniqueViolation(error: unknown): boolean {
  return (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2002'
  );
}

/**
 * DX-510: la cita de esta clave en la clínica (el único es por clínica; la
 * RLS ya la acota), con la huella de su petición y la fila del motivo del
 * sobrecupo, o null.
 */
async function replayIn(
  tx: Prisma.TransactionClient,
  tenantId: string,
  key: string,
): Promise<WalkInReplay | null> {
  const appointment = await tx.appointment.findFirst({
    where: { tenantId, idempotencyKey: key },
    include: INCLUDE_PATIENT_NAME,
  });
  if (!appointment) return null;
  const override = await tx.appointmentReservedOverride.findFirst({
    where: {
      tenantId,
      appointmentId: appointment.id,
      kind: ReservedOverrideKind.WALK_IN_OVERBOOK,
    },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return {
    appointment: mapToEntity(appointment),
    overbookId: override?.id ?? null,
    fingerprint: appointment.idempotencyFingerprint,
  };
}
