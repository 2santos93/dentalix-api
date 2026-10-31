import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { AnesthesiaTechnique } from '@prisma/client';
import {
  ANESTHESIA_REPOSITORY,
  type AnesthesiaEntryRef,
  type AnesthesiaPatientContext,
  type AnesthesiaRecordPrior,
  type AnesthesiaRepository,
} from '../../domain/ports/anesthesia-repository.port';
import type {
  AnesthesiaAdministration,
  AnestheticProduct,
  WeightSource,
} from '../../domain/entities';
import {
  type AnesthesiaDoseSummary,
  type AnestheticSnapshot,
  type DoseLine,
  hasBlockingDoseAlerts,
  isValidCarpules,
  lineMg,
  summarizeAnesthesiaDose,
} from '../../domain/anesthesia-dose';
import {
  ANESTHESIA_DOSE_WINDOW_HOURS,
  type DoseWindow,
  type DoseWindowPart,
  doseWindowAround,
  doseWindowBreakdown,
  isInDoseWindow,
  worstDoseWindow,
} from '../../domain/anesthesia-window';
import {
  assertAuthor,
  CLINICAL_ENTRY_NOT_FOUND_MESSAGE,
} from '../../../clinical-entries/application/clinical-record-errors';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import {
  ageForSnapshot,
  weightForSnapshot,
} from '../../../prescriptions/domain/patient-snapshot';
import { PEDIATRIC_AGE_LIMIT } from '../../../prescriptions/domain/prescription-safety';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { civilDateIn } from '../../../../shared/time/civil-day';

export const ANESTHETIC_NOT_FOUND_MESSAGE =
  'Anestésico no encontrado en el catálogo de esta clínica';
export const ANESTHETIC_INACTIVE_MESSAGE =
  'Ese anestésico está desactivado en el catálogo de la clínica';
export const CARPULES_INVALID_MESSAGE =
  'Los carpules van de 0,25 en 0,25, entre 0,25 y 20';
export const PEDIATRIC_WEIGHT_REQUIRED_MESSAGE = `Registra el peso: en menores de ${PEDIATRIC_AGE_LIMIT} años la dosis máxima de anestésico se calcula por peso`;
export const ADMINISTERED_AT_FUTURE_MESSAGE =
  'La hora de la anestesia no puede ser futura';
export const OVERRIDE_REASON_MIN = 10;
export const OVERRIDE_REASON_MAX = 500;
/** Tolerancia del reloj del dispositivo para «la hora no es futura». */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Lo que pide el cálculo: anestésico, carpules y, si no hay, el peso. */
export interface AnesthesiaDoseInput {
  anestheticId: string;
  carpules: number;
  /** Peso anotado en el sillón; si no viene, el de la anamnesis vigente. */
  weightKg?: number;
  /**
   * Hora de la administración; por defecto, ahora. Decide la ventana de 24 h
   * del acumulado (DX-418): la previsualización y el guardado usan la misma.
   */
  administeredAt?: Date;
}

export interface RecordAnesthesiaInput extends AnesthesiaDoseInput {
  technique: AnesthesiaTechnique;
  site?: string;
  lot?: string;
  overrideReason?: string;
}

/**
 * DX-418: la ventana del acumulado del paciente y su desglose por evolución
 * y profesional (lo ya registrado; la dosis que se previsualiza va aparte).
 */
export interface AnesthesiaDoseWindowView {
  hours: number;
  from: Date;
  to: Date;
  parts: DoseWindowPart[];
  /** mg de la dosis previsualizada, sin guardar; null si no hay. */
  pendingMg: number | null;
}

/** Lo que la web enseña: el acumulado y el paciente (edad y peso usado). */
export interface AnesthesiaCheckResult {
  /** Acumulado del PACIENTE en la ventana (DX-418), no solo la evolución. */
  summary: AnesthesiaDoseSummary;
  ageYears: number | null;
  weightSource: WeightSource | null;
  /** < 12 años sin peso: no se puede guardar hasta anotarlo. */
  weightRequired: boolean;
  window: AnesthesiaDoseWindowView;
}

export interface EntryAnesthesia {
  /** Lo registrado en ESTA evolución. */
  records: AnesthesiaAdministration[];
  /** Acumulado del PACIENTE en las últimas 24 h (DX-418). */
  summary: AnesthesiaDoseSummary;
  window: AnesthesiaDoseWindowView;
}

export type RecordedAnesthesia = AnesthesiaAdministration & {
  summary: AnesthesiaDoseSummary;
};

function trimmedOrNull(value: string | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

export function snapshotOf(
  a: AnestheticProduct | AnesthesiaAdministration,
): AnestheticSnapshot {
  return {
    name: 'anestheticName' in a ? a.anestheticName : a.name,
    activeIngredient: a.activeIngredient,
    concentrationPct: a.concentrationPct,
    vasoconstrictor: a.vasoconstrictor,
    mlPerCarpule: a.mlPerCarpule,
    maxMgPerKg: a.maxMgPerKg,
    maxAbsoluteMg: a.maxAbsoluteMg,
  };
}

function linesOf(records: readonly AnesthesiaAdministration[]): DoseLine[] {
  return records.map((r) => ({
    anesthetic: snapshotOf(r),
    carpules: r.carpules,
  }));
}

/**
 * Peso para el cálculo: el anotado ahora; si no, el último PESADO en el
 * sillón en esta misma evolución (más reciente que la anamnesis, que puede
 * ser antigua: un niño de 15 kg con 20 kg anotados hace meses calcularía un
 * máximo mayor del real); si no, el pesado hoy en la valoración de la hoja de
 * sedación de esta evolución (DX-407, también del sillón); si no, el pesado
 * en el sillón en otra evolución de la ventana de 24 h (DX-418: el mismo
 * día, más fiable que la anamnesis); si no, el de la anamnesis vigente; si
 * no, el último que se usó en esta evolución.
 */
function resolveWeight(
  entered: number | undefined,
  patient: AnesthesiaPatientContext,
  prior: AnesthesiaRecordPrior,
  entry: AnesthesiaEntryRef,
): { weightKg: number | null; source: WeightSource | null } {
  if (entered !== undefined) {
    const kg = weightForSnapshot(entered);
    if (kg === null) {
      throw new BadRequestException('El peso debe estar entre 0,1 y 399 kg');
    }
    return { weightKg: kg, source: 'ENTERED' };
  }
  const isMeasured = (r: AnesthesiaAdministration) =>
    r.weightKg !== null && r.weightSource === 'ENTERED';
  const latest = [...prior.entry].reverse();
  const measured = latest.find(isMeasured);
  if (measured) return { weightKg: measured.weightKg, source: 'ENTERED' };
  const sedation = weightForSnapshot(entry.sedationWeightKg ?? null);
  if (sedation !== null) return { weightKg: sedation, source: 'ENTERED' };
  const measuredToday = [...prior.window].reverse().find(isMeasured);
  if (measuredToday) {
    return { weightKg: measuredToday.weightKg, source: 'ENTERED' };
  }
  const fromAnamnesis = weightForSnapshot(patient.anamnesis?.weightKg ?? null);
  if (fromAnamnesis !== null) {
    return { weightKg: fromAnamnesis, source: 'ANAMNESIS' };
  }
  const last = latest.find((r) => r.weightKg !== null);
  return last
    ? { weightKg: last.weightKg, source: last.weightSource }
    : { weightKg: null, source: null };
}

/**
 * Sin sede (evoluciones legacy) no hay zona horaria: se usa la más
 * occidental (UTC−12), la de la fecha civil más temprana, que da la edad
 * MENOR posible. Ante la duda, el paciente cuenta como menor y se pide peso.
 */
const YOUNGEST_AGE_TIME_ZONE = 'Etc/GMT+12';

function ageOf(
  patient: AnesthesiaPatientContext,
  entry: AnesthesiaEntryRef,
  now: Date,
): number | null {
  return ageForSnapshot(
    patient.birthDate,
    civilDateIn(now, entry.timeZone ?? YOUNGEST_AGE_TIME_ZONE),
  );
}

function conflictMessage(summary: AnesthesiaDoseSummary): string {
  const blocking = summary.alerts
    .filter((a) => a.severity === 'BLOCKING')
    .map((a) => a.message)
    .join(' ');
  return `${blocking} Para registrarla, confirma con un motivo (overrideReason).`;
}

/**
 * Anestesia local en la evolución (DX-307): previsualizar el acumulado,
 * registrar (append-only) y leer. El servidor recalcula SIEMPRE al guardar,
 * con lo ya registrado bajo bloqueo: lo que enseñó la web es solo una
 * previsualización.
 *
 * DX-418: el acumulado y el tope son del PACIENTE en una ventana móvil de
 * 24 h que contiene la administración (`anesthesia-window.ts`, por qué no el
 * día civil), sumando todas sus evoluciones, sedes y profesionales de esta
 * clínica; el bloqueo es por paciente.
 */
@Injectable()
export class AnesthesiaUseCases {
  constructor(
    @Inject(ANESTHESIA_REPOSITORY)
    private readonly repo: AnesthesiaRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Reloj inyectable en los tests. */
  now: () => Date = () => new Date();

  private async context(patientId: string, entryId: string) {
    const patient = await this.repo.loadPatientContext(patientId);
    if (!patient) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const entry = await this.repo.findEntry(patientId, entryId);
    if (!entry) throw new NotFoundException(CLINICAL_ENTRY_NOT_FOUND_MESSAGE);
    // DX-089: un miembro acotado a sedes no escribe ni lee la anestesia de
    // una atención en otra sede (403).
    if (entry.locationId) {
      this.tenantContext.assertLocationAllowed(entry.locationId);
    }
    return { patient, entry };
  }

  private async anesthetic(id: string): Promise<AnestheticProduct> {
    const product = await this.repo.findProduct(id);
    if (!product) throw new NotFoundException(ANESTHETIC_NOT_FOUND_MESSAGE);
    if (!product.active) {
      throw new BadRequestException(ANESTHETIC_INACTIVE_MESSAGE);
    }
    return product;
  }

  /** Hora de la administración (ahora si no viene); nunca futura. */
  private administeredAt(input: AnesthesiaDoseInput): Date {
    const now = this.now();
    const at = input.administeredAt ?? now;
    if (at.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw new BadRequestException(ADMINISTERED_AT_FUTURE_MESSAGE);
    }
    return at;
  }

  /**
   * `prior.window` es lo leído en `doseWindowAround(at)` (±24 h); el
   * acumulado es el de la peor ventana de 24 h que contiene `at`
   * (`worstDoseWindow`), que también se devuelve con sus registros para el
   * desglose.
   */
  private compute<R extends AnesthesiaAdministration>(
    patient: AnesthesiaPatientContext,
    entry: AnesthesiaEntryRef,
    prior: { entry: AnesthesiaAdministration[]; window: R[] },
    at: Date,
    input: AnesthesiaDoseInput | null,
    product: AnestheticProduct | null,
  ): Omit<AnesthesiaCheckResult, 'window'> & {
    window: DoseWindow;
    windowRecords: R[];
  } {
    if (input && !isValidCarpules(input.carpules)) {
      throw new BadRequestException(CARPULES_INVALID_MESSAGE);
    }
    const weight = resolveWeight(input?.weightKg, patient, prior, entry);
    const window = worstDoseWindow(at, prior.window, weight.weightKg);
    const windowRecords = prior.window.filter((r) =>
      isInDoseWindow(r.administeredAt, window),
    );
    const lines = linesOf(windowRecords);
    if (input && product) {
      lines.push({ anesthetic: snapshotOf(product), carpules: input.carpules });
    }
    const summary = summarizeAnesthesiaDose({
      lines,
      weightKg: weight.weightKg,
      anamnesis: patient.anamnesis,
    });
    const ageYears = ageOf(patient, entry, this.now());
    return {
      summary,
      window,
      windowRecords,
      ageYears,
      weightSource: weight.source,
      weightRequired:
        weight.weightKg === null &&
        ageYears !== null &&
        ageYears < PEDIATRIC_AGE_LIMIT,
    };
  }

  /** Lo registrado en la evolución y en la ventana, con los nombres. */
  private async prior(patientId: string, entryId: string, window: DoseWindow) {
    const entry = await this.repo.listByEntry(patientId, entryId);
    const inWindow = await this.repo.listPatientWindow(patientId, window);
    return { entry, window: inWindow };
  }

  private windowView(
    window: DoseWindow,
    records: Parameters<typeof doseWindowBreakdown>[0],
    weightKg: number | null,
    entryId: string,
    pendingMg: number | null,
  ): AnesthesiaDoseWindowView {
    return {
      hours: ANESTHESIA_DOSE_WINDOW_HOURS,
      from: window.from,
      to: window.to,
      parts: doseWindowBreakdown(records, weightKg, entryId),
      pendingMg,
    };
  }

  /** Previsualización: no guarda nada. */
  async check(
    patientId: string,
    entryId: string,
    input: AnesthesiaDoseInput,
  ): Promise<AnesthesiaCheckResult> {
    const at = this.administeredAt(input);
    const { patient, entry } = await this.context(patientId, entryId);
    const product = await this.anesthetic(input.anestheticId);
    const prior = await this.prior(patientId, entryId, doseWindowAround(at));
    const { window, windowRecords, ...result } = this.compute(
      patient,
      entry,
      prior,
      at,
      input,
      product,
    );
    return {
      ...result,
      window: this.windowView(
        window,
        windowRecords,
        result.summary.weightKg,
        entryId,
        lineMg(snapshotOf(product), input.carpules),
      ),
    };
  }

  /** La evolución y el acumulado del paciente en las últimas 24 h. */
  async listByEntry(
    patientId: string,
    entryId: string,
  ): Promise<
    EntryAnesthesia & {
      ageYears: number | null;
      weightRequired: boolean;
    }
  > {
    const { patient, entry } = await this.context(patientId, entryId);
    const now = this.now();
    const prior = await this.prior(patientId, entryId, doseWindowAround(now));
    const result = this.compute(patient, entry, prior, now, null, null);
    return {
      records: prior.entry,
      summary: result.summary,
      ageYears: result.ageYears,
      weightRequired: result.weightRequired,
      window: this.windowView(
        result.window,
        result.windowRecords,
        result.summary.weightKg,
        entryId,
        null,
      ),
    };
  }

  async listByPatient(patientId: string): Promise<AnesthesiaAdministration[]> {
    const patient = await this.repo.loadPatientContext(patientId);
    if (!patient) throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    const allowed = this.tenantContext.getAllowedLocationIds();
    const records = await this.repo.listByPatient(patientId);
    return allowed === 'ALL'
      ? records
      : records.filter(
          (r) => r.locationId === null || allowed.includes(r.locationId),
        );
  }

  async record(
    patientId: string,
    entryId: string,
    input: RecordAnesthesiaInput,
    authorId: string,
  ): Promise<RecordedAnesthesia> {
    const author = assertAuthor(authorId);
    if (!isValidCarpules(input.carpules)) {
      throw new BadRequestException(CARPULES_INVALID_MESSAGE);
    }
    const reason = trimmedOrNull(input.overrideReason);
    if (
      reason !== null &&
      (reason.length < OVERRIDE_REASON_MIN ||
        reason.length > OVERRIDE_REASON_MAX)
    ) {
      throw new BadRequestException(
        `El motivo debe tener entre ${OVERRIDE_REASON_MIN} y ${OVERRIDE_REASON_MAX} caracteres`,
      );
    }
    const administeredAt = this.administeredAt(input);
    const { patient, entry } = await this.context(patientId, entryId);
    const product = await this.anesthetic(input.anestheticId);

    // El acumulado que decidió el guardado, para devolverlo con el registro.
    const decided: { summary?: AnesthesiaDoseSummary } = {};
    const created = await this.repo.record(
      patientId,
      entryId,
      doseWindowAround(administeredAt),
      (prior) => {
        const result = this.compute(
          patient,
          entry,
          prior,
          administeredAt,
          input,
          product,
        );
        if (result.weightRequired) {
          throw new BadRequestException(PEDIATRIC_WEIGHT_REQUIRED_MESSAGE);
        }
        const blocking = hasBlockingDoseAlerts(result.summary.alerts);
        if (blocking && reason === null) {
          throw new ConflictException({
            statusCode: 409,
            error: 'Conflict',
            message: conflictMessage(result.summary),
            summary: result.summary,
            safetyAlerts: result.summary.alerts,
          });
        }
        decided.summary = result.summary;
        return {
          patientId,
          clinicalEntryId: entryId,
          locationId: entry.locationId,
          anesthetic: product,
          carpules: input.carpules,
          doseMg: lineMg(snapshotOf(product), input.carpules),
          technique: input.technique,
          site: trimmedOrNull(input.site),
          lot: trimmedOrNull(input.lot),
          administeredAt,
          weightKg: result.summary.weightKg,
          weightSource: result.weightSource,
          cumulativeMg: result.summary.totalMg,
          cumulativePercent: result.summary.percent,
          safetyRulesVersion: result.summary.rulesVersion,
          safetyAlerts: result.summary.alerts,
          // Solo se sella si hizo falta: un motivo sin aviso bloqueante sobra.
          overrideReason: blocking ? reason : null,
          authorId: author,
        };
      },
    );
    if (!decided.summary) {
      throw new Error('El repositorio no llamó al cálculo de la anestesia');
    }
    return { ...created, summary: decided.summary };
  }
}
