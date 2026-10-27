import { Inject, Injectable } from '@nestjs/common';
import { ClinicRole } from '@prisma/client';
import { computePatientAging } from '../../receivables/application/compute-patient-aging';
import {
  COLLECTIONS_REPOSITORY,
  type CollectionsRepository,
} from '../domain/ports/collections-repository.port';
import { overdueView, type OverdueBalance } from '../domain/overdue-balance';
import { COLLECTIONS_CLOCK, type CollectionsClock } from './collections-clock';

/** Roles que ven el IMPORTE vencido (dato financiero, como la cartera). */
export const OVERDUE_AMOUNT_ROLES: readonly ClinicRole[] = [
  ClinicRole.ADMIN,
  ClinicRole.RECEPTION,
];

/**
 * Marca «Saldo vencido» de un LOTE de pacientes (DX-150): la agenda pide la de
 * todos los pacientes de sus tarjetas a la vez. Número FIJO de consultas
 * (resumen `patient_ledgers` por clave primaria + zonas de las sedes), sin
 * importar cuántas citas haya: sin N+1. El saldo es el de la cartera (DX-145).
 */
@Injectable()
export class PatientBalanceFlags {
  constructor(
    @Inject(COLLECTIONS_REPOSITORY)
    private readonly repo: CollectionsRepository,
    @Inject(COLLECTIONS_CLOCK) private readonly now: CollectionsClock,
  ) {}

  async forPatients(
    patientIds: readonly string[],
    role: ClinicRole | null,
  ): Promise<Map<string, OverdueBalance>> {
    const out = new Map<string, OverdueBalance>();
    const ids = [...new Set(patientIds)];
    for (const id of ids) out.set(id, overdueView(undefined, false));
    if (ids.length === 0) return out;
    const ledgers = await this.repo.ledgersOf(ids);
    if (ledgers.length === 0) return out;
    const zoneOf = await this.repo.locationTimeZones();
    const now = this.now();
    const withAmounts = role !== null && OVERDUE_AMOUNT_ROLES.includes(role);
    for (const ledger of ledgers) {
      const timeZone = zoneOf(ledger.locationId);
      out.set(
        ledger.patientId,
        overdueView(
          computePatientAging(ledger, { now, timeZone }),
          withAmounts,
        ),
      );
    }
    return out;
  }

  async forPatient(
    patientId: string,
    role: ClinicRole | null,
  ): Promise<OverdueBalance> {
    const map = await this.forPatients([patientId], role);
    return map.get(patientId) ?? overdueView(undefined, false);
  }
}
