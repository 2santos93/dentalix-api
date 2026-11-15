import type {
  AnesthesiaTechnique,
  AppointmentStatus,
  AsaClass,
  CatalogKind,
  ClinicalDiagnosisKind,
  ConsentSignerType,
  PrescriptionStatus,
  SedationAgentKind,
  SedationDoseUnit,
  SedationGrade,
  SedationRoute,
  ToothRecordOrigin,
  ToothRecordStatus,
  ToothSurface,
} from '@prisma/client';
import type { ClinicalEntry } from '../../clinical-entries/domain/entities/clinical-entry.entity';
import type {
  Allergy,
  AnswerStatus,
  Condition,
  DentalHistory,
  Habits,
  MedicalHistory,
  MedicalHistorySource,
  Medication,
  Surgery,
  VitalSigns,
} from '../../medical-history/domain/entities/medical-history.entity';
import type { ToothRecord } from '../../odontogram/domain/entities/tooth-record.entity';
import { activeRecords } from '../../odontogram/domain/record-projection';
import type { AnesthesiaAdministration } from '../../anesthesia/domain/entities';
import type { SedationSheet } from '../../sedation/domain/entities';
import type { PatientConsentSummary } from '../../consents/domain/entities/patient-consent.entity';
import type { Prescription } from '../../prescriptions/domain/entities/prescription.entity';
import type { ClinicalRecordCopySection } from './clinical-record-copy';

/**
 * DX-456: el CONTENIDO de una copia de la historia clínica, armado a partir de
 * lo que devuelven las lecturas de la historia (las mismas que pinta la
 * ficha). Función pura: recibe lo leído y la ventana, y decide qué entra.
 *
 * La ventana:
 * - `start`/`end`: el período en la zona de la sede, `[start, end)`.
 * - `asOf`: el instante de la generación. Lo registrado DESPUÉS no entra
 *   (una adenda posterior, una evolución con fecha atrasada escrita luego,
 *   una anulación posterior): reimprimir la copia da el mismo documento.
 *
 * Cada sección va en orden cronológico (lo más antiguo primero), como se lee
 * un expediente impreso. Nunca lleva ids internos.
 */
export interface CopyWindow {
  start: Date;
  end: Date;
  asOf: Date;
}

/** Nombres que el documento necesita y que las lecturas dan como ids. */
export interface CopyLookups {
  userName(id: string | null): string | null;
  locationName(id: string | null): string | null;
  /** Sede de cada evolución (la entidad de la historia no la lleva). */
  entryLocationId(entryId: string): string | null;
  catalogLabel(id: string | null): string | null;
}

/** Cita del paciente tal y como la lee la copia (sin ids en la salida). */
export interface CopyAppointmentSource {
  start: Date;
  end: Date;
  status: AppointmentStatus;
  providerId: string;
  locationId: string;
  typeName: string | null;
  reason: string | null;
  createdAt: Date;
}

export interface CopySources {
  evolutions?: readonly ClinicalEntry[];
  anamnesis?: readonly MedicalHistory[];
  toothRecords?: readonly ToothRecord[];
  anesthesia?: readonly AnesthesiaAdministration[];
  sedation?: readonly SedationSheet[];
  consents?: readonly PatientConsentSummary[];
  prescriptions?: readonly Prescription[];
  appointments?: readonly CopyAppointmentSource[];
}

export interface CopyDiagnosis {
  icd10Code: string;
  label: string;
  kind: ClinicalDiagnosisKind;
  toothFdi: string | null;
}

export interface CopyAddendum {
  createdAt: Date;
  authorName: string | null;
  reason: string;
  text: string;
}

export interface CopyEvolution {
  entryDate: Date;
  authorName: string | null;
  authorLicense: string | null;
  locationName: string | null;
  appointmentStart: Date | null;
  reason: string | null;
  notes: string;
  diagnoses: CopyDiagnosis[];
  /** En orden cronológico, como en la ficha. */
  addenda: CopyAddendum[];
}

export interface CopyDiagnosisLine extends CopyDiagnosis {
  entryDate: Date;
  authorName: string | null;
}

export interface CopyAnamnesis {
  version: number;
  recordedAt: Date;
  authorName: string | null;
  source: MedicalHistorySource;
  allergies: Allergy[];
  conditions: Condition[];
  medications: Medication[];
  surgeries: Surgery[];
  habits: Habits | null;
  pregnancy: AnswerStatus | null;
  dentalHistory: DentalHistory | null;
  vitalSigns: VitalSigns | null;
  familyHistory: string | null;
  notes: string | null;
}

export interface CopyToothRecord {
  toothNumber: string;
  recordedAt: Date;
  kind: CatalogKind;
  label: string | null;
  surfaces: ToothSurface[];
  status: ToothRecordStatus;
  origin: ToothRecordOrigin;
  notes: string | null;
  authorName: string | null;
}

export interface CopyAnesthesia {
  administeredAt: Date;
  anestheticName: string;
  activeIngredient: string;
  concentrationPct: number;
  vasoconstrictor: string | null;
  carpules: number;
  doseMg: number;
  technique: AnesthesiaTechnique;
  site: string | null;
  lot: string | null;
  authorName: string | null;
  locationName: string | null;
}

export interface CopySedationAgent {
  administeredAt: Date;
  kind: SedationAgentKind;
  drugName: string | null;
  dose: number | null;
  doseUnit: SedationDoseUnit | null;
  route: SedationRoute;
  n2oPercent: number | null;
}

export interface CopySedation {
  assessedAt: Date;
  grade: SedationGrade;
  asaClass: AsaClass | null;
  authorName: string | null;
  locationName: string | null;
  agents: CopySedationAgent[];
  dischargedAt: Date | null;
}

export interface CopyConsent {
  title: string;
  signedAt: Date;
  signerType: ConsentSignerType;
  signerName: string;
  professionalName: string;
  /** Con las dos firmas (DX-243). */
  complete: boolean;
}

export interface CopyPrescriptionItem {
  activeIngredient: string;
  brandName: string | null;
  concentration: string;
  pharmaceuticalForm: string;
  route: string;
  dose: string;
  frequency: string;
  durationDays: number;
  instructions: string | null;
}

export interface CopyPrescription {
  issuedAt: Date;
  professionalName: string;
  locationName: string;
  /** El estado en el momento de la generación. */
  status: PrescriptionStatus;
  notes: string | null;
  items: CopyPrescriptionItem[];
}

export interface CopyAppointment {
  start: Date;
  end: Date;
  status: AppointmentStatus;
  providerName: string | null;
  locationName: string | null;
  typeName: string | null;
  reason: string | null;
}

export interface CopyContent {
  evolutions?: CopyEvolution[];
  diagnoses?: CopyDiagnosisLine[];
  anamnesis?: CopyAnamnesis[];
  odontogram?: CopyToothRecord[];
  anesthesia?: CopyAnesthesia[];
  sedation?: CopySedation[];
  consents?: CopyConsent[];
  prescriptions?: CopyPrescription[];
  appointments?: CopyAppointment[];
}

const inWindow = (instant: Date, w: CopyWindow): boolean =>
  instant.getTime() >= w.start.getTime() && instant.getTime() < w.end.getTime();

const notAfter = (instant: Date, asOf: Date): boolean =>
  instant.getTime() <= asOf.getTime();

const byTime =
  <T>(at: (item: T) => Date) =>
  (a: T, b: T): number =>
    at(a).getTime() - at(b).getTime();

/**
 * Evoluciones del período. Las anuladas no llegan: la lectura de la historia
 * (`ListClinicalEntriesUseCase`) ya las deja fuera (`deletedAt`), igual que en
 * la ficha. Aquí solo se aplica el corte de la generación.
 */
function evolutionsOf(
  entries: readonly ClinicalEntry[],
  w: CopyWindow,
): ClinicalEntry[] {
  return entries
    .filter((e) => inWindow(e.entryDate, w) && notAfter(e.createdAt, w.asOf))
    .map((e) => ({
      ...e,
      addenda: e.addenda.filter((a) => notAfter(a.createdAt, w.asOf)),
    }))
    .sort(byTime((e) => e.entryDate));
}

function diagnosisOf(d: ClinicalEntry['diagnoses'][number]): CopyDiagnosis {
  return {
    icd10Code: d.icd10Code,
    label: d.labelEs,
    kind: d.kind,
    toothFdi: d.toothFdi,
  };
}

export function assembleCopyContent(
  sections: readonly ClinicalRecordCopySection[],
  sources: CopySources,
  w: CopyWindow,
  names: CopyLookups,
): CopyContent {
  const wanted = new Set(sections);
  const content: CopyContent = {};
  const entries = evolutionsOf(sources.evolutions ?? [], w);

  if (wanted.has('EVOLUTIONS')) {
    content.evolutions = entries.map((e) => ({
      entryDate: e.entryDate,
      authorName: names.userName(e.performedById),
      authorLicense: e.authorProfessionalLicense,
      locationName: names.locationName(names.entryLocationId(e.id)),
      appointmentStart: e.appointment?.start ?? null,
      reason: e.reason,
      notes: e.notes,
      diagnoses: e.diagnoses.map(diagnosisOf),
      addenda: e.addenda.map((a) => ({
        createdAt: a.createdAt,
        authorName: names.userName(a.authorId),
        reason: a.reason,
        text: a.text,
      })),
    }));
  }

  if (wanted.has('DIAGNOSES')) {
    content.diagnoses = entries.flatMap((e) =>
      e.diagnoses.map((d) => ({
        ...diagnosisOf(d),
        entryDate: e.entryDate,
        authorName: names.userName(e.performedById),
      })),
    );
  }

  if (wanted.has('ANAMNESIS')) {
    content.anamnesis = (sources.anamnesis ?? [])
      .filter((v) => inWindow(v.createdAt, w) && notAfter(v.createdAt, w.asOf))
      .sort(byTime((v) => v.createdAt))
      .map((v) => ({
        version: v.version,
        recordedAt: v.createdAt,
        authorName: names.userName(v.createdById),
        source: v.source,
        allergies: v.allergies,
        conditions: v.conditions,
        medications: v.medications,
        surgeries: v.surgeries,
        habits: v.habits,
        pregnancy: v.pregnancy,
        dentalHistory: v.dentalHistory,
        vitalSigns: v.vitalSigns,
        familyHistory: v.familyHistory,
        notes: v.notes,
      }));
  }

  if (wanted.has('ODONTOGRAM')) {
    // Como la carta de la ficha con `asOf` (DX-120), con la MISMA proyección:
    // lo anulado antes del fin del período no sale; lo anulado después, sí.
    // Lo escrito tras la generación (registros y anulaciones) no cuenta.
    const recorded = (sources.toothRecords ?? []).filter((r) =>
      notAfter(r.createdAt, w.asOf),
    );
    content.odontogram = activeRecords(recorded, w.end)
      .filter((r) => inWindow(r.recordedAt, w))
      .sort(byTime((r) => r.recordedAt))
      .map((r) => ({
        toothNumber: r.toothNumber,
        recordedAt: r.recordedAt,
        kind: r.kind,
        label: names.catalogLabel(r.catalogItemId),
        surfaces: r.surfaces,
        status: r.status,
        origin: r.origin,
        notes: r.notes,
        authorName: names.userName(r.performedById),
      }));
  }

  if (wanted.has('ANESTHESIA_SEDATION')) {
    content.anesthesia = (sources.anesthesia ?? [])
      .filter(
        (a) => inWindow(a.administeredAt, w) && notAfter(a.createdAt, w.asOf),
      )
      .sort(byTime((a) => a.administeredAt))
      .map((a) => ({
        administeredAt: a.administeredAt,
        anestheticName: a.anestheticName,
        activeIngredient: a.activeIngredient,
        concentrationPct: a.concentrationPct,
        vasoconstrictor: a.vasoconstrictor,
        carpules: a.carpules,
        doseMg: a.doseMg,
        technique: a.technique,
        site: a.site,
        lot: a.lot,
        authorName: names.userName(a.authorId),
        locationName: names.locationName(a.locationId),
      }));
    content.sedation = (sources.sedation ?? [])
      .filter((s) => inWindow(s.assessedAt, w) && notAfter(s.createdAt, w.asOf))
      .sort(byTime((s) => s.assessedAt))
      .map((s) => ({
        assessedAt: s.assessedAt,
        grade: s.grade,
        asaClass: s.asaClass,
        authorName: s.author.name,
        locationName: names.locationName(s.locationId),
        agents: s.agents
          .filter((g) => notAfter(g.createdAt, w.asOf))
          .sort(byTime((g) => g.administeredAt))
          .map((g) => ({
            administeredAt: g.administeredAt,
            kind: g.kind,
            drugName: g.drugName,
            dose: g.dose,
            doseUnit: g.doseUnit,
            route: g.route,
            n2oPercent: g.n2oPercent,
          })),
        dischargedAt:
          s.discharge && notAfter(s.discharge.createdAt, w.asOf)
            ? s.discharge.dischargedAt
            : null,
      }));
  }

  if (wanted.has('CONSENTS')) {
    content.consents = (sources.consents ?? [])
      .filter((c) => inWindow(c.signedAt, w) && notAfter(c.signedAt, w.asOf))
      .sort(byTime((c) => c.signedAt))
      .map((c) => ({
        title: c.title,
        signedAt: c.signedAt,
        signerType: c.signerType,
        signerName: c.signerName,
        professionalName: c.professionalName,
        complete:
          c.complete &&
          (c.professionalSignedAt === null ||
            notAfter(c.professionalSignedAt, w.asOf)),
      }));
  }

  if (wanted.has('PRESCRIPTIONS')) {
    content.prescriptions = (sources.prescriptions ?? [])
      .filter((p) => inWindow(p.issuedAt, w) && notAfter(p.issuedAt, w.asOf))
      .sort(byTime((p) => p.issuedAt))
      .map((p) => ({
        issuedAt: p.issuedAt,
        professionalName: p.professionalName,
        locationName: p.locationName,
        status:
          p.voidedAt !== null && notAfter(p.voidedAt, w.asOf)
            ? 'VOIDED'
            : 'ISSUED',
        notes: p.notes,
        items: [...p.items]
          .sort((a, b) => a.position - b.position)
          .map((i) => ({
            activeIngredient: i.activeIngredient,
            brandName: i.brandName,
            concentration: i.concentration,
            pharmaceuticalForm: i.pharmaceuticalForm,
            route: i.route,
            dose: i.dose,
            frequency: i.frequency,
            durationDays: i.durationDays,
            instructions: i.instructions,
          })),
      }));
  }

  if (wanted.has('APPOINTMENTS')) {
    content.appointments = (sources.appointments ?? [])
      .filter((a) => inWindow(a.start, w) && notAfter(a.createdAt, w.asOf))
      .sort(byTime((a) => a.start))
      .map((a) => ({
        start: a.start,
        end: a.end,
        status: a.status,
        providerName: names.userName(a.providerId),
        locationName: names.locationName(a.locationId),
        typeName: a.typeName,
        reason: a.reason,
      }));
  }

  return content;
}

/** «Sin registros en el período»: ninguna sección elegida trae nada. */
export function isCopyEmpty(content: CopyContent): boolean {
  return Object.values(content).every(
    (rows) => !Array.isArray(rows) || rows.length === 0,
  );
}
