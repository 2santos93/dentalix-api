import { Injectable } from '@nestjs/common';
import {
  AppointmentConfirmationResponse,
  AppointmentStatus,
  Prisma,
} from '@prisma/client';
import { enqueueWaitlistFromAppointment } from '../../../waitlist/infrastructure/waitlist-transitions';
import { computeCancellationNotice } from '../../../cancellation-policies/domain/cancellation-policy';
import {
  linkResponseBlock,
  type LinkCancellationPolicy,
} from '../../domain/link-cancellation-policy';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  AppointmentConfirmationRepository,
  ConfirmationLookup,
  IssueConfirmationInput,
  RespondConfirmationInput,
  RespondOutcome,
} from '../../domain/ports/appointment-confirmation-repository.port';
import {
  AppointmentConfirmation,
  ClinicBranding,
  ConfirmationAppointment,
} from '../../domain/entities/appointment-confirmation.entity';

/** Solo lo que el flujo necesita: nada clínico (ni motivo ni notas). */
const APPOINTMENT_SELECT = {
  id: true,
  start: true,
  end: true,
  status: true,
  providerId: true,
  locationId: true,
  patient: { select: { firstName: true, phone: true, countryCode: true } },
  location: { select: { name: true, address: true } },
} as const satisfies Prisma.AppointmentSelect;

type SelectedAppointment = Prisma.AppointmentGetPayload<{
  select: typeof APPOINTMENT_SELECT;
}>;

const CONFIRMATION_SELECT = {
  id: true,
  appointmentId: true,
  expiresAt: true,
  appointmentStart: true,
  appointmentStatus: true,
  respondedAt: true,
  response: true,
  revokedAt: true,
} as const satisfies Prisma.AppointmentConfirmationSelect;

/** Prisma DateTime usa TIMESTAMP UTC sin zona en PostgreSQL. */
const utc = (date: Date) =>
  Prisma.sql`(${date.toISOString()}::timestamptz AT TIME ZONE 'UTC')`;

/** Qué le hace a la cita cada respuesta del paciente. */
function appointmentPatchFor(
  response: AppointmentConfirmationResponse,
  now: Date,
): Prisma.AppointmentUpdateManyMutationInput {
  switch (response) {
    case AppointmentConfirmationResponse.CONFIRM:
      return { status: AppointmentStatus.CONFIRMED };
    case AppointmentConfirmationResponse.CANCEL:
      return { status: AppointmentStatus.CANCELLED };
    case AppointmentConfirmationResponse.CALL_ME:
      return { callbackRequestedAt: now };
  }
}

/** Fuerza el ROLLBACK de `respond` cuando la cita cambió bajo nuestros pies. */
class StaleAppointmentError extends Error {}

/** DX-291: fuerza el ROLLBACK cuando la política no deja registrar la respuesta. */
class PolicyBlockError extends Error {
  constructor(readonly outcome: 'POLICY_CHANGED' | 'ACK_REQUIRED') {
    super(outcome);
  }
}

/**
 * DX-291: política VIGENTE de una sede (la de mayor versión), con el texto
 * para el paciente, dentro de la transacción del llamador.
 */
async function currentLinkPolicy(
  tx: Prisma.TransactionClient,
  locationId: string,
): Promise<LinkCancellationPolicy | null> {
  const policy = await tx.cancellationPolicyVersion.findFirst({
    where: { locationId },
    orderBy: { version: 'desc' },
    select: {
      id: true,
      version: true,
      noticeHours: true,
      patientText: true,
      suggestedFee: true,
      currency: true,
    },
  });
  return policy
    ? {
        ...policy,
        suggestedFee:
          policy.suggestedFee === null ? null : policy.suggestedFee.toNumber(),
      }
    : null;
}

@Injectable()
export class PrismaAppointmentConfirmationRepository implements AppointmentConfirmationRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Mismo motivo que en PrismaAppointmentRepository: un INSERT necesita el tenantId explícito. */
  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  private async toAppointment(
    tx: Prisma.TransactionClient,
    a: SelectedAppointment,
  ): Promise<ConfirmationAppointment> {
    // El profesional es un usuario global; su nombre se lee a través de la
    // membresía, que tiene RLS, así que solo aparece si es de esta clínica.
    // Sin filtrar `deletedAt`: si dejó la clínica, la cita sigue siendo suya.
    const membership = await tx.clinicMembership.findFirst({
      where: { userId: a.providerId },
      orderBy: { createdAt: 'desc' },
      select: { user: { select: { fullName: true } } },
    });
    return {
      id: a.id,
      start: a.start,
      end: a.end,
      status: a.status,
      patientFirstName: a.patient.firstName,
      patientPhone: a.patient.phone,
      patientCountryCode: a.patient.countryCode,
      providerName: membership?.user.fullName ?? null,
      locationId: a.locationId,
      locationName: a.location.name,
      locationAddress: a.location.address,
    };
  }

  async findAppointment(
    appointmentId: string,
  ): Promise<ConfirmationAppointment | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const appointment = await tx.appointment.findFirst({
        where: { id: appointmentId, deletedAt: null },
        select: APPOINTMENT_SELECT,
      });
      return appointment ? this.toAppointment(tx, appointment) : null;
    });
  }

  async issue(input: IssueConfirmationInput): Promise<void> {
    const tenantId = this.requireTenantId();
    await this.prisma.runWithTenant(async (tx) => {
      // Mismo orden de locks que respond: primero cita, después enlaces.
      await tx.$queryRaw`SELECT "id" FROM "appointments"
        WHERE "id" = ${input.appointmentId}::uuid FOR UPDATE`;
      // Recepción sustituye; los automáticos conservan lo ya enviado.
      if (input.revokePrevious !== false)
        await tx.appointmentConfirmation.updateMany({
          where: {
            appointmentId: input.appointmentId,
            respondedAt: null,
            revokedAt: null,
          },
          data: { revokedAt: input.now },
        });
      await tx.appointmentConfirmation.create({
        data: {
          tenantId,
          appointmentId: input.appointmentId,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          appointmentStart: input.appointmentStart,
          appointmentStatus: input.appointmentStatus,
          createdById: input.createdById,
        },
      });
      // Un nuevo enlace de recepción reemplaza a cualquier "pide llamada"
      // anterior: la conversación vuelve a empezar desde este mensaje. El del
      // recordatorio automático (DX-026) no: la llamada sigue pendiente.
      await tx.appointment.update({
        where: { id: input.appointmentId },
        data: {
          confirmationSentAt: input.now,
          ...(input.keepCallbackRequest ? {} : { callbackRequestedAt: null }),
        },
      });
    });
  }

  async findByTokenHash(tokenHash: string): Promise<ConfirmationLookup | null> {
    // REPEATABLE READ: enlace y cita se leen en dos sentencias y TIENEN que
    // verse en la misma foto. En READ COMMITTED, si otra respuesta hace COMMIT
    // entre las dos lecturas se ve el enlace aún sin responder pero la cita ya
    // CONFIRMED/CANCELLED → "la cita cambió" → 410, cuando lo correcto es
    // "ya respondido" (409). Era el fallo intermitente de "dos clics
    // simultáneos". Solo lee, así que RR no puede fallar por serialización.
    return this.prisma.runWithTenant(
      async (tx) => {
        const confirmation = await tx.appointmentConfirmation.findUnique({
          where: { tokenHash },
          select: CONFIRMATION_SELECT,
        });
        if (!confirmation) return null;
        const appointment = await tx.appointment.findFirst({
          where: { id: confirmation.appointmentId, deletedAt: null },
          select: APPOINTMENT_SELECT,
        });
        return {
          confirmation: confirmation satisfies AppointmentConfirmation,
          appointment: appointment
            ? await this.toAppointment(tx, appointment)
            : null,
          // DX-291: la política que verá el paciente, en la misma foto.
          policy: appointment
            ? await currentLinkPolicy(tx, appointment.locationId)
            : null,
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  async findClinicBranding(): Promise<ClinicBranding | null> {
    // `tenants` no tiene RLS (igual que PrismaTenantBrandingRepository): se lee
    // por el id ya resuelto desde el host.
    const tenantId = this.requireTenantId();
    return this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { name: true, primaryColor: true, logoUrl: true },
    });
  }

  /**
   * DX-279/291: lo que la respuesta escribe por la política vigente de la
   * sede de la cita. Cancelar guarda la hora de la respuesta (la del servidor
   * de BD), origen PATIENT_LINK, el aviso y si es tardía (sin motivo: el
   * enlace no lo pide); cancelar tarde sin aceptar la política, o con otra
   * versión que la que vio el paciente, deshace todo (PolicyBlockError). Toda
   * respuesta guarda la versión vigente como la comunicada al paciente. Si no
   * hay que tocar la cita, el UPDATE condicional no cambia nada.
   */
  private async policyPatch(
    tx: Prisma.TransactionClient,
    input: RespondConfirmationInput,
    respondedAt: Date,
  ): Promise<Prisma.AppointmentUpdateManyMutationInput> {
    const appointment = await tx.appointment.findFirstOrThrow({
      where: { id: input.appointmentId },
      select: { locationId: true },
    });
    const policy = await currentLinkPolicy(tx, appointment.locationId);
    const cancelling =
      input.response === AppointmentConfirmationResponse.CANCEL;
    const notice = computeCancellationNotice({
      start: input.expectedStart,
      cancelledAt: respondedAt,
      byKind: 'PATIENT_LINK',
      noticeHours: policy?.noticeHours ?? null,
    });
    const block = linkResponseBlock({
      cancelling,
      late: notice.lateCancellation,
      acknowledgePolicy: input.acknowledgePolicy === true,
      shownPolicyVersionId: input.shownPolicyVersionId,
      currentPolicyId: policy?.id ?? null,
    });
    if (block) throw new PolicyBlockError(block);
    return {
      ...(policy ? { policyVersionId: policy.id } : {}),
      ...(cancelling
        ? {
            cancelledAt: respondedAt,
            cancelledByKind: 'PATIENT_LINK' as const,
            noticeMinutes: notice.noticeMinutes,
            lateCancellation: notice.lateCancellation,
          }
        : {}),
    };
  }

  async respond(input: RespondConfirmationInput): Promise<RespondOutcome> {
    try {
      return await this.prisma.runWithTenant(async (tx) => {
        // Serializa todos los enlaces de la cita, incluso CALL_ME o una cita
        // ya CONFIRMED, cuyas respuestas no cambian el status.
        await tx.$queryRaw`SELECT "id" FROM "appointments"
          WHERE "id" = ${input.appointmentId}::uuid FOR UPDATE`;
        const confirmation = await tx.appointmentConfirmation.findFirst({
          where: {
            id: input.confirmationId,
            appointmentId: input.appointmentId,
          },
          select: CONFIRMATION_SELECT,
        });
        if (!confirmation || confirmation.respondedAt || confirmation.revokedAt)
          return 'ALREADY_USED';
        // El instante del request puede ser anterior a la espera del lock.
        // Reclamar con el reloj actual y clock_timestamp() verifica el plazo
        // en la propia escritura, incluso si otra sentencia hizo esperar.
        const now = new Date(Math.max(input.now.getTime(), Date.now()));
        const [claimed] = await tx.$queryRaw<{ respondedAt: Date }[]>`
          WITH response_time AS MATERIALIZED (
            SELECT GREATEST(${utc(now)}, clock_timestamp() AT TIME ZONE 'UTC') AS at
          )
          UPDATE "appointment_confirmations" AS confirmation
             SET "respondedAt" = response_time.at,
                 "response" = ${input.response}::"AppointmentConfirmationResponse",
                 "updatedAt" = response_time.at
            FROM response_time
           WHERE confirmation."id" = ${input.confirmationId}::uuid
             AND confirmation."appointmentId" = ${input.appointmentId}::uuid
             AND confirmation."respondedAt" IS NULL
             AND confirmation."revokedAt" IS NULL
             AND confirmation."expiresAt" > response_time.at
          RETURNING confirmation."respondedAt"`;
        if (!claimed) return 'STALE';

        // La cita solo se toca si sigue como al emitir el enlace; si no,
        // no se registra ninguna respuesta.
        const updated = await tx.appointment.updateMany({
          where: {
            id: input.appointmentId,
            deletedAt: null,
            start: input.expectedStart,
            status: input.expectedStatus,
          },
          data: {
            ...appointmentPatchFor(input.response, claimed.respondedAt),
            ...(await this.policyPatch(tx, input, claimed.respondedAt)),
          },
        });
        if (updated.count === 0) throw new StaleAppointmentError();
        // Una respuesta cierra todos los enlaces vivos en el mismo COMMIT.
        await tx.appointmentConfirmation.updateMany({
          where: {
            appointmentId: input.appointmentId,
            respondedAt: null,
            revokedAt: null,
          },
          data: { respondedAt: claimed.respondedAt, response: input.response },
        });
        // DX-122: el paciente canceló desde el enlace → «Pendientes por
        // agendar», en esta misma transacción (sin autor: lo hizo el paciente).
        if (input.response === AppointmentConfirmationResponse.CANCEL) {
          await enqueueWaitlistFromAppointment(tx, input.appointmentId, null);
        }
        return 'OK';
      });
    } catch (error) {
      if (error instanceof StaleAppointmentError) return 'STALE';
      if (error instanceof PolicyBlockError) return error.outcome;
      throw error;
    }
  }
}
