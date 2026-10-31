import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AppointmentStatus } from '@prisma/client';
import { APPOINTMENT_CONFIRMATION_REPOSITORY } from '../../domain/ports/appointment-confirmation-repository.port';
import type { AppointmentConfirmationRepository } from '../../domain/ports/appointment-confirmation-repository.port';
import {
  generateConfirmationToken,
  hashConfirmationToken,
} from '../confirmation-token';
import { whatsAppDigits } from '../../../../shared/phone/phone-number';
import {
  PublicAppointmentView,
  toPublicAppointmentView,
} from '../public-confirmation-view';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';

/** Solo una cita que todavía va a ocurrir tiene algo que confirmar. */
const CONFIRMABLE: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.SCHEDULED,
  AppointmentStatus.CONFIRMED,
]);

export interface CreateConfirmationLinkInput {
  appointmentId: string;
  createdById?: string;
  /**
   * Lo emite el recordatorio automático (DX-026), no recepción: no limpia un
   * «pide llamada» pendiente, que recepción todavía tiene que atender.
   */
  automatic?: boolean;
  /** DX-361: recepción (con sesión) deja el evento de auditoría. */
  audit?: AuditRequestContext;
}

export interface CreateConfirmationLinkResult {
  /** Texto plano del token: se entrega SOLO aquí, nunca se persiste. */
  token: string;
  expiresAt: Date;
  /** Número E.164 sin `+` para `wa.me`, o `null` si no hay uno utilizable. */
  whatsappPhone: string | null;
  /** Lo que el mensaje prellenado cuenta de la cita (sin nada clínico). */
  appointment: PublicAppointmentView;
}

/**
 * Recepción pide el enlace de confirmación de una cita. El token caduca al
 * inicio de la cita y queda atado a su hora y estado actuales: reagendarla o
 * cambiarle el estado lo deja sin efecto. Recepción reemplaza los anteriores; el automático los conserva.
 */
@Injectable()
export class CreateConfirmationLinkUseCase {
  constructor(
    @Inject(APPOINTMENT_CONFIRMATION_REPOSITORY)
    private readonly repo: AppointmentConfirmationRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  async execute(
    input: CreateConfirmationLinkInput,
  ): Promise<CreateConfirmationLinkResult> {
    // RLS: una cita de otra clínica es invisible, así que cae aquí como 404.
    const appointment = await this.repo.findAppointment(input.appointmentId);
    if (!appointment) {
      throw new NotFoundException('Appointment not found');
    }
    // SEC-045 (DX-089): una cita de una sede no permitida es 403, antes de
    // revocar el enlace vigente o emitir otro. El recordatorio automático
    // corre sin restricción de sedes.
    this.tenantContext.assertLocationAllowed(appointment.locationId);
    if (!CONFIRMABLE.has(appointment.status)) {
      throw new ConflictException(
        'Solo se puede pedir confirmación de una cita agendada o confirmada',
      );
    }
    const now = new Date();
    if (appointment.start.getTime() <= now.getTime()) {
      throw new BadRequestException(
        'La cita ya empezó: no tiene sentido pedir confirmación',
      );
    }

    const token = generateConfirmationToken();
    await this.repo.issue({
      appointmentId: appointment.id,
      tokenHash: hashConfirmationToken(token),
      expiresAt: appointment.start,
      appointmentStart: appointment.start,
      appointmentStatus: appointment.status,
      createdById: input.createdById,
      keepCallbackRequest: input.automatic === true,
      revokePrevious: input.automatic !== true,
      now,
      audit: input.audit,
    });

    return {
      token,
      expiresAt: appointment.start,
      // Con la región de la sede de la cita, nunca el país del paciente (P1).
      whatsappPhone: whatsAppDigits(
        appointment.patientPhone,
        appointment.locationPhoneRegion,
      ),
      appointment: toPublicAppointmentView(appointment),
    };
  }
}
