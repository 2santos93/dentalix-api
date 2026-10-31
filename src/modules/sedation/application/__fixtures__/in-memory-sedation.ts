import { randomUUID } from 'node:crypto';
import type {
  NewSedationRecord,
  NewSedationVitals,
  SedationAppend,
  SedationEntryRef,
  SedationRepository,
} from '../../domain/ports/sedation-repository.port';
import type {
  SedationActor,
  SedationSheet,
  SedationVitalsRow,
} from '../../domain/entities';

/** Repositorio en memoria de una sola clínica para los unit de DX-407. */
export class InMemorySedationRepository implements SedationRepository {
  sheets: SedationSheet[] = [];
  patients = new Set<string>();
  entries = new Map<string, SedationEntryRef & { patientId: string }>();
  /** Miembros clínicos vigentes, con su nombre. */
  members = new Map<string, string>();
  consents = new Map<string, string>();
  /** Reloj de la «BD» (la hora del servidor de `createdAt`). */
  now: () => Date = () => new Date();

  private actor(id: string): SedationActor {
    return { id, name: this.members.get(id) ?? null };
  }

  patientExists(patientId: string): Promise<boolean> {
    return Promise.resolve(this.patients.has(patientId));
  }

  findEntry(patientId: string, entryId: string) {
    const entry = this.entries.get(entryId);
    return Promise.resolve(
      entry && entry.patientId === patientId
        ? { id: entry.id, locationId: entry.locationId }
        : null,
    );
  }

  findSheet(patientId: string, entryId: string) {
    return Promise.resolve(
      this.sheets.find(
        (s) => s.patientId === patientId && s.clinicalEntryId === entryId,
      ) ?? null,
    );
  }

  listByPatient(patientId: string) {
    return Promise.resolve(
      this.sheets.filter((s) => s.patientId === patientId),
    );
  }

  isClinicalMember(userId: string): Promise<boolean> {
    return Promise.resolve(this.members.has(userId));
  }

  consentExists(patientId: string, consentId: string): Promise<boolean> {
    return Promise.resolve(this.consents.get(consentId) === patientId);
  }

  async createRecord(
    input: NewSedationRecord,
  ): Promise<SedationSheet | 'DUPLICATE'> {
    if (await this.findSheet(input.patientId, input.clinicalEntryId)) {
      return 'DUPLICATE';
    }
    const { authorId, ...rest } = input;
    const sheet: SedationSheet = {
      id: randomUUID(),
      ...rest,
      author: this.actor(authorId),
      createdAt: this.now(),
      checklist: null,
      agents: [],
      vitals: [],
      discharge: null,
    };
    this.sheets.push(sheet);
    return sheet;
  }

  private vitalsRow(v: NewSedationVitals): SedationVitalsRow {
    const { authorId, ...rest } = v;
    return {
      id: randomUUID(),
      ...rest,
      author: this.actor(authorId),
      createdAt: this.now(),
    };
  }

  async append(
    patientId: string,
    entryId: string,
    build: (sheet: SedationSheet) => SedationAppend | Promise<SedationAppend>,
  ): Promise<SedationSheet | null> {
    const sheet = await this.findSheet(patientId, entryId);
    if (!sheet) return null;
    // Copia: `build` decide sobre el estado leído, como bajo el bloqueo.
    const write = await build(structuredClone(sheet));
    switch (write.kind) {
      case 'CHECKLIST':
        sheet.checklist = {
          id: randomUUID(),
          items: write.items,
          author: this.actor(write.authorId),
          checkedAt: write.checkedAt,
          createdAt: this.now(),
        };
        break;
      case 'AGENT': {
        const { authorId, ...rest } = write.agent;
        sheet.agents.push({
          id: randomUUID(),
          ...rest,
          author: this.actor(authorId),
          createdAt: this.now(),
        });
        sheet.agents.sort(
          (a, b) => a.administeredAt.getTime() - b.administeredAt.getTime(),
        );
        break;
      }
      case 'VITALS':
        sheet.vitals.push(this.vitalsRow(write.vitals));
        sheet.vitals.sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime());
        break;
      case 'DISCHARGE': {
        const vitals = this.vitalsRow(write.vitals);
        sheet.vitals.push(vitals);
        const { operatorId, monitorId, ...rest } = write.discharge;
        sheet.discharge = {
          id: randomUUID(),
          ...rest,
          vitalsId: vitals.id,
          operator: this.actor(operatorId),
          monitor: this.actor(monitorId),
          createdAt: this.now(),
        };
        break;
      }
    }
    return sheet;
  }
}
