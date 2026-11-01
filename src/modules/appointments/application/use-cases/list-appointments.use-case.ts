import {
  BadRequestException,
  Inject,
  Injectable,
  Optional,
} from '@nestjs/common';
import { APPOINTMENT_REPOSITORY } from '../../domain/ports/appointment-repository.port';
import type { AppointmentRepository } from '../../domain/ports/appointment-repository.port';
import { Appointment } from '../../domain/entities/appointment.entity';
import { STAFF_REPOSITORY } from '../../../staff/domain/ports/staff-repository.port';
import type { StaffRepository } from '../../../staff/domain/ports/staff-repository.port';
import {
  attendsAt,
  PROVIDER_NOT_AT_LOCATION_MESSAGE,
} from '../../../staff/domain/provider-location';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  CHAIR_REPOSITORY,
  type ChairRepository,
} from '../../../chairs/domain/ports/chair-repository.port';
import { MAX_CHAIR_COLUMNS } from '../../../chairs/domain/chair-rules';

export const CHAIR_NOT_AT_LOCATION_MESSAGE = 'Algún sillón no es de esta sede';
export const CHAIR_FILTER_NEEDS_LOCATION_MESSAGE =
  'Indica la sede para ver la agenda por sillón';

/** DX-121: columnas de la vista Día como mucho (12 = scroll interno en web). */
export const MAX_PROVIDER_COLUMNS = 12;

export interface ListAppointmentsInput {
  from: Date;
  to: Date;
  providerId?: string;
  /** DX-121: profesionales de las columnas (ids del personal de la clínica). */
  providerIds?: string[];
  /** DX-121: sede explícita (si no, la del request). */
  locationId?: string;
  /** DX-211: sillones de las columnas (de la sede objetivo). */
  chairIds?: string[];
}

@Injectable()
export class ListAppointmentsUseCase {
  constructor(
    @Inject(APPOINTMENT_REPOSITORY)
    private readonly repo: AppointmentRepository,
    @Inject(STAFF_REPOSITORY)
    private readonly staff: StaffRepository,
    private readonly tenantContext: TenantContextService,
    // DX-211: opcional para los dobles de los specs anteriores (sin sillones).
    @Optional()
    @Inject(CHAIR_REPOSITORY)
    private readonly chairs: Pick<ChairRepository, 'findByIds'> | null = null,
  ) {}

  /**
   * Ordering (start ASC) and the active/deletedAt:null filter are the
   * repository's responsibility (see PrismaAppointmentRepository / the
   * in-memory fake in the spec for the same contract) — this use case only
   * forwards the range + filters, after validating `providerIds`.
   */
  async execute(input: ListAppointmentsInput): Promise<Appointment[]> {
    // DX-089: una sede explícita fuera de las permitidas es 403.
    if (input.locationId) {
      this.tenantContext.assertLocationAllowed(input.locationId);
    }
    const target = input.locationId ?? this.tenantContext.getLocationId();
    const providerIds =
      input.providerIds !== undefined
        ? await this.validProviderIds(input.providerIds, target)
        : undefined;
    const chairIds =
      input.chairIds !== undefined
        ? await this.validChairIds(input.chairIds, target)
        : undefined;
    return this.repo.listByRange({
      from: input.from,
      to: input.to,
      providerId: input.providerId,
      providerIds,
      locationId: input.locationId,
      chairIds,
    });
  }

  /**
   * DX-211: `chairIds` son sillones (activos o no: una cita conserva el suyo)
   * de la sede objetivo. Uno de otra sede o clínica (RLS) es 400, igual que
   * un profesional ajeno: la columna no existe en esta agenda.
   */
  private async validChairIds(
    ids: string[],
    target: string | undefined,
  ): Promise<string[]> {
    if (target === undefined) {
      throw new BadRequestException(CHAIR_FILTER_NEEDS_LOCATION_MESSAGE);
    }
    const unique = [...new Set(ids)];
    if (unique.length > MAX_CHAIR_COLUMNS) {
      throw new BadRequestException(
        `Puedes ver como mucho ${MAX_CHAIR_COLUMNS} sillones a la vez`,
      );
    }
    const found = this.chairs ? await this.chairs.findByIds(unique) : [];
    if (
      found.length !== unique.length ||
      found.some((chair) => chair.locationId !== target)
    ) {
      throw new BadRequestException(CHAIR_NOT_AT_LOCATION_MESSAGE);
    }
    return unique;
  }

  /**
   * `providerIds` se valida contra el personal ACTIVO de la clínica (RLS): un
   * id ajeno no daría datos (la RLS ya lo impide), pero responder 400 deja
   * claro que la columna no existe en vez de pintarla vacía. DX-121d: con
   * sede objetivo (explícita o del request), cada profesional tiene que
   * atender en ella; sin sede no se comprueba.
   */
  private async validProviderIds(
    ids: string[],
    target: string | undefined,
  ): Promise<string[]> {
    const unique = [...new Set(ids)];
    if (unique.length > MAX_PROVIDER_COLUMNS) {
      throw new BadRequestException(
        `Puedes ver como mucho ${MAX_PROVIDER_COLUMNS} profesionales a la vez`,
      );
    }
    const active = new Map(
      (await this.staff.listActive()).map((member) => [member.userId, member]),
    );
    if (unique.some((id) => !active.has(id))) {
      throw new BadRequestException(
        'Algún profesional no pertenece a esta clínica',
      );
    }
    if (
      target !== undefined &&
      unique.some((id) => !attendsAt(active.get(id)!, target))
    ) {
      throw new BadRequestException(PROVIDER_NOT_AT_LOCATION_MESSAGE);
    }
    return unique;
  }
}
