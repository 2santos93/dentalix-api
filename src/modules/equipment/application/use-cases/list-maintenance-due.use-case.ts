import { Inject, Injectable } from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import {
  maintenanceDueHorizon,
  selectMaintenanceDue,
  type MaintenanceDueItem,
} from '../../domain/maintenance-due';
import {
  EQUIPMENT_CLOCK,
  EQUIPMENT_REPOSITORY,
  type EquipmentClock,
  type EquipmentRepository,
} from '../../domain/ports/equipment-repository.port';

/** Cuántos avisos devuelve por defecto «Mi día» (el resto, en Ajustes). */
export const MAINTENANCE_DUE_LIMIT_DEFAULT = 10;
export const MAINTENANCE_DUE_LIMIT_MAX = 50;

export interface ListMaintenanceDueOutput {
  /** Instante del cálculo. */
  generatedAt: string;
  items: MaintenanceDueItem[];
  /** Todos los avisos del alcance (los `items` son los primeros). */
  total: number;
}

/**
 * DX-543 · «Mantenimientos de equipos» en «Mi día»: los equipos activos con el
 * preventivo vencido o que vence en ≤30 días, en la sede activa (o las
 * permitidas al usuario; sin restricción ni cabecera, toda la clínica), como
 * la lista de DX-542. La BD preselecciona hasta el día UTC + 31 y el dominio
 * decide con el «hoy» de cada sede.
 */
@Injectable()
export class ListMaintenanceDueUseCase {
  constructor(
    @Inject(EQUIPMENT_REPOSITORY) private readonly repo: EquipmentRepository,
    private readonly tenantContext: TenantContextService,
    @Inject(EQUIPMENT_CLOCK) private readonly clock: EquipmentClock,
  ) {}

  async execute(input: { limit?: number }): Promise<ListMaintenanceDueOutput> {
    const now = this.clock();
    const locationIds = this.tenantContext.scopeLocationIds();
    // `loc = []`: ninguna sede, nada que leer.
    const records =
      locationIds !== undefined && locationIds.length === 0
        ? []
        : await this.repo.listMaintenanceCandidates({
            locationIds,
            dueOnOrBefore: maintenanceDueHorizon(now),
          });
    const all = selectMaintenanceDue(records, now);
    return {
      generatedAt: now.toISOString(),
      items: all.slice(0, input.limit ?? MAINTENANCE_DUE_LIMIT_DEFAULT),
      total: all.length,
    };
  }
}
