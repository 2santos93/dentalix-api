import type { ClinicDocumentTypeNames } from '../../../patients/domain/document-type';
import type {
  ImplantCardPatient,
  ImplantCatalogEntry,
  ImplantLotMatch,
  PatientImplant,
} from '../../domain/entities/patient-implant.entity';
import type { ImplantCardLocation } from '../../domain/implant-card';
import type {
  CreatePatientImplantRepoInput,
  ImplantLotQuery,
  PatientImplantRepository,
  VoidImplantOutcome,
} from '../../domain/ports/patient-implant-repository.port';

/** Repositorio en memoria para los tests de casos de uso (una clínica). */
export class InMemoryImplantRepository implements PatientImplantRepository {
  patients = new Map<string, ImplantCardPatient>();
  planItems = new Map<string, string>(); // itemId -> patientId
  implants: PatientImplant[] = [];
  location = { id: 'loc-1', timeZone: 'America/Bogota' };
  private seq = 0;

  loadPatient(patientId: string): Promise<ImplantCardPatient | null> {
    return Promise.resolve(this.patients.get(patientId) ?? null);
  }

  resolveLocation(): Promise<{ id: string; timeZone: string }> {
    return Promise.resolve(this.location);
  }

  planItemBelongsToPatient(
    itemId: string,
    patientId: string,
  ): Promise<boolean> {
    return Promise.resolve(this.planItems.get(itemId) === patientId);
  }

  create(input: CreatePatientImplantRepoInput): Promise<PatientImplant> {
    this.seq += 1;
    const implant: PatientImplant = {
      ...input,
      id: `impl-${this.seq}`,
      locationName: 'Sede principal',
      professionalName: 'Dra. Prueba',
      createdAt: new Date(Date.UTC(2026, 9, 17, 12, this.seq)),
      voidedAt: null,
      voidedById: null,
      voidedByName: null,
      voidReason: null,
      cardDeliveredAt: null,
    };
    this.implants.push(implant);
    return Promise.resolve(implant);
  }

  listByPatient(patientId: string): Promise<PatientImplant[]> {
    return Promise.resolve(
      this.implants.filter((i) => i.patientId === patientId).reverse(),
    );
  }

  listByPatientOn(
    patientId: string,
    placedOn: string,
  ): Promise<PatientImplant[]> {
    return Promise.resolve(
      this.implants.filter(
        (i) => i.patientId === patientId && i.placedOn === placedOn,
      ),
    );
  }

  findById(id: string): Promise<PatientImplant | null> {
    return Promise.resolve(this.implants.find((i) => i.id === id) ?? null);
  }

  void(
    id: string,
    input: { voidedById: string; voidedAt: Date; reason: string },
  ): Promise<VoidImplantOutcome> {
    const implant = this.implants.find((i) => i.id === id);
    if (!implant) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (implant.voidedAt) return Promise.resolve({ kind: 'ALREADY_VOIDED' });
    Object.assign(implant, {
      voidedAt: input.voidedAt,
      voidedById: input.voidedById,
      voidReason: input.reason,
    });
    return Promise.resolve({ kind: 'VOIDED', implant });
  }

  markCardDelivered(
    patientId: string,
    placedOn: string,
    input: { deliveredById: string; deliveredAt: Date },
  ): Promise<void> {
    for (const i of this.implants) {
      if (
        i.patientId === patientId &&
        i.placedOn === placedOn &&
        !i.voidedAt &&
        !i.cardDeliveredAt
      ) {
        i.cardDeliveredAt = input.deliveredAt;
      }
    }
    return Promise.resolve();
  }

  clinicName(): Promise<string> {
    return Promise.resolve('Clínica Demo');
  }

  locations(ids: string[]): Promise<ImplantCardLocation[]> {
    return Promise.resolve(
      ids.map((id) => ({ id, name: 'Sede principal', address: null })),
    );
  }

  catalog(): Promise<ImplantCatalogEntry[]> {
    return Promise.resolve([]);
  }

  lastQuery: ImplantLotQuery | null = null;
  lastNames: ClinicDocumentTypeNames | null = null;

  searchByLot(
    query: ImplantLotQuery,
    names: ClinicDocumentTypeNames,
  ): Promise<ImplantLotMatch[]> {
    this.lastQuery = query;
    this.lastNames = names;
    return Promise.resolve([]);
  }
}
