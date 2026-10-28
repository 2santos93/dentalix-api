import type {
  CreateResponsiblePartyData,
  PatientResponsiblesSnapshot,
  ResponsiblePartyRepository,
  ResponsiblePartyView,
  ResponsiblePatientSummary,
  UpdateResponsiblePartyData,
} from '../../domain/ports/responsible-party-repository.port';
import type {
  NoticePatientFields,
  NoticeSettings,
} from '../../domain/communication/notice-recipient';

interface FakePatient extends ResponsiblePatientSummary {
  notice: NoticePatientFields;
}

/** Repositorio en memoria del bloque «Responsable y familia» (DX-203). */
export class FakeResponsiblePartyRepository implements ResponsiblePartyRepository {
  readonly patients = new Map<string, FakePatient>();
  readonly parties: (ResponsiblePartyView & { deleted: boolean })[] = [];
  /** Zona de la sede y mayoría de edad de la clínica (DX-328). */
  noticeSettings: NoticeSettings = {
    timeZone: 'America/Bogota',
    majorityAge: 18,
  };
  private seq = 0;

  addPatient(
    id: string,
    over: Partial<NoticePatientFields> & { lastName?: string } = {},
  ): void {
    const notice: NoticePatientFields = {
      firstName: over.firstName ?? 'Paciente',
      birthDate: over.birthDate ?? null,
      email: over.email ?? null,
      emergencyContactName: over.emergencyContactName ?? null,
    };
    this.patients.set(id, {
      id,
      firstName: notice.firstName,
      lastName: over.lastName ?? 'Pérez',
      docType: 'CC',
      docNumber: null,
      email: notice.email,
      phone: null,
      notice,
    });
  }

  private live(patientId: string) {
    return this.parties.filter((p) => p.patientId === patientId && !p.deleted);
  }

  load(patientId: string): Promise<PatientResponsiblesSnapshot | null> {
    const patient = this.patients.get(patientId);
    if (!patient) return Promise.resolve(null);
    const parties = this.live(patientId).map(({ deleted: _d, ...p }) => p);
    return Promise.resolve({
      patient: { id: patientId, ...patient.notice },
      parties,
      noticeResponsibles: parties.map((p) => ({
        id: p.id,
        name: p.fullName,
        email: p.email,
        isPayer: p.isPayer,
        receivesNotices: p.receivesNotices,
        optedOut: false,
      })),
      responsibleFor: this.parties
        .filter((p) => !p.deleted && p.responsiblePatient?.id === patientId)
        .map((p) => {
          const child = this.patients.get(p.patientId) as FakePatient;
          return {
            id: p.id,
            patient: {
              id: child.id,
              firstName: child.firstName,
              lastName: child.lastName,
            },
            relationship: p.relationship,
            isPayer: p.isPayer,
            receivesNotices: p.receivesNotices,
          };
        }),
      noticeSettings: { ...this.noticeSettings },
    });
  }

  findPatient(patientId: string): Promise<ResponsiblePatientSummary | null> {
    const p = this.patients.get(patientId);
    if (!p) return Promise.resolve(null);
    const { notice: _n, ...summary } = p;
    return Promise.resolve(summary);
  }

  create(
    patientId: string,
    data: CreateResponsiblePartyData,
  ): Promise<ResponsiblePartyView> {
    const responsible = data.responsiblePatientId
      ? (this.patients.get(data.responsiblePatientId) ?? null)
      : null;
    const now = new Date('2026-10-17T15:00:00.000Z');
    const view = {
      id: `party-${++this.seq}`,
      patientId,
      kind: responsible ? ('PATIENT' as const) : ('CONTACT' as const),
      responsiblePatient: responsible
        ? (({ notice: _n, ...s }) => s)(responsible)
        : null,
      fullName: responsible
        ? `${responsible.firstName} ${responsible.lastName}`
        : (data.contact?.fullName ?? ''),
      docType: responsible
        ? responsible.docType
        : (data.contact?.docType ?? null),
      docNumber: responsible
        ? responsible.docNumber
        : (data.contact?.docNumber ?? null),
      email: responsible ? responsible.email : (data.contact?.email ?? null),
      phone: responsible ? responsible.phone : (data.contact?.phone ?? null),
      relationship: data.relationship,
      isPayer: data.isPayer,
      receivesNotices: data.receivesNotices,
      migratedFromGuardian: false,
      createdAt: now,
      updatedAt: now,
    };
    this.parties.push({ ...view, deleted: false });
    return Promise.resolve(view);
  }

  update(
    patientId: string,
    partyId: string,
    data: UpdateResponsiblePartyData,
  ): Promise<ResponsiblePartyView | null> {
    const party = this.live(patientId).find((p) => p.id === partyId);
    if (!party) return Promise.resolve(null);
    if (data.relationship !== undefined) party.relationship = data.relationship;
    if (data.isPayer !== undefined) party.isPayer = data.isPayer;
    if (data.receivesNotices !== undefined) {
      party.receivesNotices = data.receivesNotices;
    }
    Object.assign(party, data.contact ?? {});
    const { deleted: _d, ...view } = party;
    return Promise.resolve(view);
  }

  remove(patientId: string, partyId: string): Promise<boolean> {
    const party = this.live(patientId).find((p) => p.id === partyId);
    if (!party) return Promise.resolve(false);
    party.deleted = true;
    return Promise.resolve(true);
  }
}
