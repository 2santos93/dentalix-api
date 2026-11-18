import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { OnlineBookingStatus } from '@prisma/client';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { CreateAppointmentUseCase } from '../../../appointments/application/use-cases/create-appointment.use-case';
import { ONLINE_BOOKING_MESSAGES } from '../../domain/online-booking-errors';
import {
  ONLINE_MAX_IDS,
  ONLINE_SETTINGS_MESSAGES,
  durationProblem,
  settingsProblem,
  type OnlineBookingSettings,
  type OnlineTypeSettings,
  type OnlineTypeView,
} from '../../domain/online-booking-settings';
import {
  ONLINE_BOOKING_REPOSITORY,
  type OnlineBookingRepository,
  type OnlineRequestView,
} from '../../domain/ports/online-booking-repository.port';
import { OnlineBookingEmail } from '../online-booking-email';
import { OnlineSlotService } from '../online-slot.service';
import { OnlineChairService } from '../online-chair.service';

/** Ajustes de la reserva online (los lee la agenda; los cambia el ADMIN). */
@Injectable()
export class OnlineBookingSettingsUseCases {
  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY)
    private readonly repo: OnlineBookingRepository,
  ) {}

  get(): Promise<OnlineBookingSettings> {
    return this.repo.getSettings();
  }

  async update(
    next: Omit<OnlineBookingSettings, 'updatedAt'>,
    ctx: AuditRequestContext,
  ): Promise<OnlineBookingSettings> {
    const problem = settingsProblem({ ...next, updatedAt: null });
    if (problem) throw new BadRequestException(problem);
    return this.repo.saveSettings(next, ctx);
  }
}

/** Los tipos del catálogo en la reserva online (ADMIN). */
@Injectable()
export class OnlineBookingTypesUseCases {
  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY)
    private readonly repo: OnlineBookingRepository,
    private readonly slots: OnlineSlotService,
  ) {}

  list(): Promise<OnlineTypeView[]> {
    return this.repo.listTypes();
  }

  async update(
    input: OnlineTypeSettings,
    ctx: AuditRequestContext,
  ): Promise<OnlineTypeView> {
    const type = await this.repo.findType(input.appointmentTypeId);
    if (!type)
      throw new NotFoundException(ONLINE_SETTINGS_MESSAGES.typeNotFound);
    if (input.visibleOnline && !type.active) {
      throw new ConflictException(ONLINE_SETTINGS_MESSAGES.inactiveType);
    }
    const duration =
      durationProblem(input.durationNewMinutes) ??
      durationProblem(input.durationExistingMinutes);
    if (duration) throw new BadRequestException(duration);
    const providerIds = [...new Set(input.providerIds)];
    const locationIds = [...new Set(input.locationIds)];
    if (
      providerIds.length > ONLINE_MAX_IDS ||
      locationIds.length > ONLINE_MAX_IDS
    ) {
      throw new BadRequestException(ONLINE_SETTINGS_MESSAGES.tooManyIds);
    }
    // Ids de ESTA clínica: sedes activas y profesionales que atienden.
    const active = await this.repo.activeLocationIds();
    if (locationIds.some((id) => !active.includes(id))) {
      throw new BadRequestException(ONLINE_SETTINGS_MESSAGES.unknownLocation);
    }
    const providers = await this.slots.providers(active);
    if (providerIds.some((id) => !providers.some((p) => p.id === id))) {
      throw new BadRequestException(ONLINE_SETTINGS_MESSAGES.unknownProvider);
    }
    return this.repo.saveType({ ...input, providerIds, locationIds }, ctx);
  }
}

export interface ListOnlineRequestsInput {
  status: OnlineBookingStatus | null;
  page: number;
  pageSize: number;
}

/**
 * Bandeja «Solicitudes online» de recepción. DX-089: la lista filtra por las
 * sedes permitidas EN LA CONSULTA; aceptar o rechazar una de otra sede es 403.
 */
@Injectable()
export class OnlineBookingRequestsUseCases {
  constructor(
    @Inject(ONLINE_BOOKING_REPOSITORY)
    private readonly repo: OnlineBookingRepository,
    private readonly tenantContext: TenantContextService,
    private readonly createAppointment: CreateAppointmentUseCase,
    private readonly email: OnlineBookingEmail,
    private readonly chairs: OnlineChairService,
  ) {}

  list(
    input: ListOnlineRequestsInput,
  ): Promise<{ items: OnlineRequestView[]; total: number }> {
    return this.repo.listRequests({
      ...input,
      locationIds: this.tenantContext.scopeLocationIds(),
    });
  }

  async pendingCount(): Promise<{ pending: number }> {
    return {
      pending: await this.repo.countPending(
        this.tenantContext.scopeLocationIds(),
      ),
    };
  }

  private async pending(id: string): Promise<OnlineRequestView> {
    const request = await this.repo.findRequest(id);
    if (!request)
      throw new NotFoundException(ONLINE_BOOKING_MESSAGES.requestNotFound);
    this.tenantContext.assertRecordLocationAllowed(request.location.id);
    if (request.status !== 'PENDING') {
      throw new ConflictException(ONLINE_BOOKING_MESSAGES.requestNotPending);
    }
    return request;
  }

  /**
   * Aceptar: crea la cita ONLINE con TODAS las reglas de agendar (puede dar
   * el 409 de siempre si la hora ya se ocupó) y marca la solicitud en la
   * MISMA transacción; si otra persona la resolvió a la vez, no se crea nada.
   */
  async accept(
    id: string,
    ctx: AuditRequestContext,
    requestHost: string | undefined,
  ): Promise<OnlineRequestView> {
    const request = await this.pending(id);
    // DX-583: la cita nace con sillón libre (regla DX-480), en la MISMA alta.
    const created = await this.chairs.withFreeChair(
      {
        locationId: request.location.id,
        start: request.start,
        end: request.end,
      },
      (chairId) =>
        this.createAppointment.execute({
          patientId: request.patient.id,
          providerId: request.provider.id,
          locationId: request.location.id,
          appointmentTypeId: request.appointmentType.id,
          start: request.start,
          end: request.end,
          chairId,
          createdById: ctx.actor.userId,
          actorRole: ctx.actor.role,
          origin: 'ONLINE',
          inTransaction: async (tx, appointment) => {
            const ok = await this.repo.acceptInTx(
              tx,
              id,
              appointment.id,
              ctx,
              request.patient.id,
            );
            if (!ok) {
              throw new ConflictException(
                ONLINE_BOOKING_MESSAGES.requestNotPending,
              );
            }
          },
        }),
      () => new ConflictException(ONLINE_BOOKING_MESSAGES.noFreeChair),
    );
    const manageUrl = await this.email.manageUrl(
      ctx.tenantId,
      created.id,
      requestHost,
    );
    await this.email.sendReceived({
      tenantId: ctx.tenantId,
      patientId: request.patient.id,
      referenceId: created.id,
      clinicName: '',
      state: 'ACCEPTED',
      start: request.start,
      locationId: request.location.id,
      providerName: request.provider.fullName,
      manageUrl,
    });
    return (await this.repo.findRequest(id))!;
  }

  async decline(
    id: string,
    ctx: AuditRequestContext,
  ): Promise<OnlineRequestView> {
    const request = await this.pending(id);
    if (!(await this.repo.decline(id, ctx, request.patient.id))) {
      throw new ConflictException(ONLINE_BOOKING_MESSAGES.requestNotPending);
    }
    return (await this.repo.findRequest(id))!;
  }
}
