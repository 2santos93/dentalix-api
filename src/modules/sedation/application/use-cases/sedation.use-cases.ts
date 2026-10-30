import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { SedationVitalsPhase } from '@prisma/client';
import {
  SEDATION_REPOSITORY,
  type NewSedationVitals,
  type SedationRepository,
} from '../../domain/ports/sedation-repository.port';
import {
  SEDATION_TEMPLATE_SOURCE,
  type SedationTemplateSource,
} from '../../domain/ports/sedation-template-source.port';
import type { SedationSheet } from '../../domain/entities';
import type { SedationTemplate } from '../../domain/sedation-template';
import {
  SEDATION_RULES_VERSION,
  agentProblems,
  assessmentProblems,
  bodyMassIndex,
  buildChecklistItems,
  buildDischargeCriteria,
  checklistProblems,
  dischargeProblems,
  reversalDoses,
  vitalsProblems,
  vitalsWatch,
  type SedationAgentInput,
  type SedationAssessmentInput,
  type SedationDischargeInput,
  type SedationMark,
  type SedationProblem,
  type SedationVitalsValues,
  type VitalsWatch,
} from '../../domain/sedation-rules';
import {
  assertAuthor,
  CLINICAL_ENTRY_NOT_FOUND_MESSAGE,
} from '../../../clinical-entries/application/clinical-record-errors';
import { PATIENT_NOT_FOUND_MESSAGE } from '../../../patients/application/assert-patient-in-clinic';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';

export const SEDATION_NOT_FOUND_MESSAGE =
  'Esta evolución aún no tiene hoja de sedación: empieza por la valoración previa';
export const SEDATION_DUPLICATE_MESSAGE =
  'Esta evolución ya tiene hoja de sedación. Lo registrado no se edita: corrige con una adenda.';
export const SEDATION_CLOSED_MESSAGE =
  'La hoja de sedación ya tiene el egreso firmado: no admite más registros. Corrige con una adenda.';
export const SEDATION_CHECKLIST_DONE_MESSAGE =
  'El checklist previo ya está registrado. Lo registrado no se edita: corrige con una adenda.';
export const SEDATION_CHECKLIST_REQUIRED_MESSAGE =
  'Completa el checklist previo antes de administrar fármacos, tomar constantes intraoperatorias o dar el egreso.';
export const SEDATION_CONSENT_NOT_FOUND_MESSAGE =
  'Consentimiento no encontrado entre los firmados por este paciente';
export const SEDATION_MONITOR_INVALID_MESSAGE =
  'Quien monitoriza tiene que ser un miembro clínico de esta clínica (odontólogo, asistente o administrador)';
export const SEDATION_TIME_FUTURE_MESSAGE = 'La hora no puede ser futura';
/** Tolerancia del reloj del dispositivo para «la hora no es futura». */
const CLOCK_SKEW_MS = 5 * 60 * 1000;

export type SedationAssessInput = SedationAssessmentInput;

export interface SedationAgentRequest extends SedationAgentInput {
  administeredAt?: Date;
}

export interface SedationVitalsRequest extends SedationVitalsValues {
  /** Por esta vía, basal o intraoperatoria; la del alta va con el egreso. */
  phase: Exclude<SedationVitalsPhase, 'DISCHARGE'>;
  takenAt?: Date;
}

export interface SedationDischargeRequest extends SedationDischargeInput {
  dischargedAt?: Date;
}

export type SedationStatus =
  'ASSESSED' | 'CHECKED' | 'IN_PROGRESS' | 'DISCHARGED';

/** La hoja con su estado y el aviso de intervalo, calculados al leer. */
export type SedationSheetView = SedationSheet & {
  status: SedationStatus;
  watch: VitalsWatch;
};

export interface EntrySedation {
  /** Plantilla de la hoja (la suya si existe; si no, con la que se abriría). */
  template: SedationTemplate;
  sheet: SedationSheetView | null;
}

function trimmedOrNull(value: string | undefined): string | null {
  const t = value?.trim();
  return t ? t : null;
}

function rejectProblems(problems: SedationProblem[]): void {
  if (problems.length === 0) return;
  throw new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: problems.map((p) => p.message).join(' '),
    problems,
  });
}

function statusOf(sheet: SedationSheet): SedationStatus {
  if (sheet.discharge) return 'DISCHARGED';
  if (!sheet.checklist) return 'ASSESSED';
  const started =
    sheet.agents.length > 0 || sheet.vitals.some((v) => v.phase === 'INTRA');
  return started ? 'IN_PROGRESS' : 'CHECKED';
}

function lastEventAt(sheet: SedationSheet): Date | null {
  const times = [
    ...sheet.agents.map((a) => a.administeredAt.getTime()),
    ...sheet.vitals.map((v) => v.takenAt.getTime()),
  ];
  return times.length > 0 ? new Date(Math.max(...times)) : null;
}

function vitalsRow(
  phase: SedationVitalsPhase,
  takenAt: Date,
  v: SedationVitalsValues,
  authorId: string,
): NewSedationVitals {
  return {
    phase,
    takenAt,
    spo2: v.spo2 ?? null,
    heartRate: v.heartRate ?? null,
    systolic: v.systolic ?? null,
    diastolic: v.diastolic ?? null,
    respiratoryRate: v.respiratoryRate ?? null,
    etco2: v.etco2 ?? null,
    sedationLevel: v.sedationLevel ?? null,
    authorId,
  };
}

/**
 * Hoja de sedación consciente en la evolución (DX-407): valoración previa,
 * checklist, fármacos, constantes por tiempo y egreso. Cada parte es una fila
 * nueva e inalterable; el servidor valida con la plantilla de la hoja y
 * calcula IMC, reversores por peso y el aviso de intervalo sin toma.
 */
@Injectable()
export class SedationUseCases {
  constructor(
    @Inject(SEDATION_REPOSITORY)
    private readonly repo: SedationRepository,
    @Inject(SEDATION_TEMPLATE_SOURCE)
    private readonly templates: SedationTemplateSource,
    private readonly tenantContext: TenantContextService,
  ) {}

  /** Reloj inyectable en los tests. */
  now: () => Date = () => new Date();

  private async entry(patientId: string, entryId: string) {
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const entry = await this.repo.findEntry(patientId, entryId);
    if (!entry) throw new NotFoundException(CLINICAL_ENTRY_NOT_FOUND_MESSAGE);
    // DX-089: un miembro acotado a sedes no lee ni escribe la hoja de una
    // atención en otra sede (403).
    if (entry.locationId) {
      this.tenantContext.assertLocationAllowed(entry.locationId);
    }
    return entry;
  }

  private async templateOf(sheet: SedationSheet): Promise<SedationTemplate> {
    return (
      (await this.templates.byVersion(sheet.templateVersion)) ??
      (await this.templates.current())
    );
  }

  private view(sheet: SedationSheet): SedationSheetView {
    return {
      ...sheet,
      status: statusOf(sheet),
      watch: vitalsWatch(
        {
          intervalMinutes: sheet.vitalsIntervalMinutes,
          checklistDone: sheet.checklist !== null,
          discharged: sheet.discharge !== null,
          agentTimes: sheet.agents.map((a) => a.administeredAt),
          vitals: sheet.vitals,
        },
        this.now(),
      ),
    };
  }

  private notFuture(time: Date | undefined): Date {
    const now = this.now();
    const value = time ?? now;
    if (value.getTime() > now.getTime() + CLOCK_SKEW_MS) {
      throw new BadRequestException(SEDATION_TIME_FUTURE_MESSAGE);
    }
    return value;
  }

  private async appendTo(
    patientId: string,
    entryId: string,
    build: Parameters<SedationRepository['append']>[2],
  ): Promise<SedationSheetView> {
    await this.entry(patientId, entryId);
    const sheet = await this.repo.append(patientId, entryId, build);
    if (!sheet) throw new NotFoundException(SEDATION_NOT_FOUND_MESSAGE);
    return this.view(sheet);
  }

  async getEntry(patientId: string, entryId: string): Promise<EntrySedation> {
    await this.entry(patientId, entryId);
    const sheet = await this.repo.findSheet(patientId, entryId);
    return {
      template: sheet
        ? await this.templateOf(sheet)
        : await this.templates.current(),
      sheet: sheet ? this.view(sheet) : null,
    };
  }

  async listByPatient(patientId: string): Promise<SedationSheetView[]> {
    if (!(await this.repo.patientExists(patientId))) {
      throw new NotFoundException(PATIENT_NOT_FOUND_MESSAGE);
    }
    const allowed = this.tenantContext.getAllowedLocationIds();
    const sheets = await this.repo.listByPatient(patientId);
    return sheets
      .filter(
        (s) =>
          allowed === 'ALL' ||
          s.locationId === null ||
          allowed.includes(s.locationId),
      )
      .map((s) => this.view(s));
  }

  /** Abre la hoja con la valoración previa. */
  async assess(
    patientId: string,
    entryId: string,
    input: SedationAssessInput,
    authorId: string,
  ): Promise<SedationSheetView> {
    const author = assertAuthor(authorId);
    const entry = await this.entry(patientId, entryId);
    const template = await this.templates.current();
    rejectProblems(assessmentProblems(input, template));
    if (
      input.consentId !== undefined &&
      !(await this.repo.consentExists(patientId, input.consentId))
    ) {
      throw new NotFoundException(SEDATION_CONSENT_NOT_FOUND_MESSAGE);
    }
    const weightKg = input.weightKg ?? null;
    const heightCm = input.heightCm ?? null;
    const reversal = reversalDoses(weightKg);
    const created = await this.repo.createRecord({
      patientId,
      clinicalEntryId: entryId,
      locationId: entry.locationId,
      templateVersion: template.version,
      rulesVersion: SEDATION_RULES_VERSION,
      vitalsIntervalMinutes: template.vitalsIntervalMinutes,
      grade: input.grade,
      asaClass: input.asaClass ?? null,
      asaEmergency: input.asaEmergency,
      highAsaInterconsultation: trimmedOrNull(input.highAsaInterconsultation),
      highAsaJustification: trimmedOrNull(input.highAsaJustification),
      fastingClearLiquidsHours: input.fastingClearLiquidsHours ?? null,
      fastingSolidsHours: input.fastingSolidsHours ?? null,
      mallampati: input.mallampati ?? null,
      weightKg,
      heightCm,
      bmi: bodyMassIndex(weightKg, heightCm),
      naloxoneMg: reversal?.naloxoneMg ?? null,
      flumazenilMg: reversal?.flumazenilMg ?? null,
      escortName: trimmedOrNull(input.escortName),
      escortRelationship: trimmedOrNull(input.escortRelationship),
      consentConfirmed: input.consentConfirmed,
      consentId: input.consentId ?? null,
      authorId: author,
    });
    if (created === 'DUPLICATE') {
      throw new ConflictException(SEDATION_DUPLICATE_MESSAGE);
    }
    return this.view(created);
  }

  /** Checklist previo: hora del servidor y quien lo marca. */
  async check(
    patientId: string,
    entryId: string,
    marks: SedationMark[],
    authorId: string,
  ): Promise<SedationSheetView> {
    const author = assertAuthor(authorId);
    return this.appendTo(patientId, entryId, async (sheet) => {
      if (sheet.discharge) throw new ConflictException(SEDATION_CLOSED_MESSAGE);
      if (sheet.checklist) {
        throw new ConflictException(SEDATION_CHECKLIST_DONE_MESSAGE);
      }
      const template = await this.templateOf(sheet);
      rejectProblems(checklistProblems(marks, template));
      return {
        kind: 'CHECKLIST',
        items: buildChecklistItems(marks, template),
        authorId: author,
      };
    });
  }

  async addAgent(
    patientId: string,
    entryId: string,
    input: SedationAgentRequest,
    authorId: string,
  ): Promise<SedationSheetView> {
    const author = assertAuthor(authorId);
    const administeredAt = this.notFuture(input.administeredAt);
    const route =
      input.kind === 'NITROUS_OXIDE'
        ? (input.route ?? 'INHALED')
        : input.kind === 'ORAL'
          ? (input.route ?? 'ORAL')
          : input.route;
    rejectProblems(agentProblems({ ...input, route }));
    if (!route) throw new Error('agentProblems dejó pasar un fármaco sin vía');
    return this.appendTo(patientId, entryId, (sheet) => {
      if (sheet.discharge) throw new ConflictException(SEDATION_CLOSED_MESSAGE);
      if (!sheet.checklist) {
        throw new ConflictException(SEDATION_CHECKLIST_REQUIRED_MESSAGE);
      }
      return {
        kind: 'AGENT',
        agent: {
          kind: input.kind,
          drugName: trimmedOrNull(input.drugName),
          dose: input.dose ?? null,
          doseUnit: input.doseUnit ?? null,
          route,
          n2oPercent: input.n2oPercent ?? null,
          flowLpm: input.flowLpm ?? null,
          administeredAt,
          authorId: author,
        },
      };
    });
  }

  async addVitals(
    patientId: string,
    entryId: string,
    input: SedationVitalsRequest,
    authorId: string,
  ): Promise<SedationSheetView> {
    const author = assertAuthor(authorId);
    const takenAt = this.notFuture(input.takenAt);
    return this.appendTo(patientId, entryId, async (sheet) => {
      if (sheet.discharge) throw new ConflictException(SEDATION_CLOSED_MESSAGE);
      if (input.phase === 'INTRA' && !sheet.checklist) {
        throw new ConflictException(SEDATION_CHECKLIST_REQUIRED_MESSAGE);
      }
      rejectProblems(vitalsProblems(input, await this.templateOf(sheet)));
      return {
        kind: 'VITALS',
        vitals: vitalsRow(input.phase, takenAt, input, author),
      };
    });
  }

  /** Egreso firmado por el operador (quien lo registra) con quien monitorizó. */
  async discharge(
    patientId: string,
    entryId: string,
    input: SedationDischargeRequest,
    authorId: string,
  ): Promise<SedationSheetView> {
    const operator = assertAuthor(authorId);
    const dischargedAt = this.notFuture(input.dischargedAt);
    await this.entry(patientId, entryId);
    if (!(await this.repo.isClinicalMember(input.monitorId))) {
      throw new BadRequestException(SEDATION_MONITOR_INVALID_MESSAGE);
    }
    return this.appendTo(patientId, entryId, async (sheet) => {
      if (sheet.discharge) throw new ConflictException(SEDATION_CLOSED_MESSAGE);
      if (!sheet.checklist) {
        throw new ConflictException(SEDATION_CHECKLIST_REQUIRED_MESSAGE);
      }
      const template = await this.templateOf(sheet);
      rejectProblems(
        dischargeProblems(input, template, {
          grade: sheet.grade,
          operatorId: operator,
          lastEventAt: lastEventAt(sheet),
          dischargedAt,
        }),
      );
      return {
        kind: 'DISCHARGE',
        vitals: vitalsRow('DISCHARGE', dischargedAt, input.vitals, operator),
        discharge: {
          criteria: buildDischargeCriteria(input.criteria, template),
          aldreteScore: input.aldreteScore ?? null,
          dischargedAt,
          handedOverToName: input.handedOverToName.trim(),
          handedOverToRelationship: input.handedOverToRelationship.trim(),
          instructionsDelivered: input.instructionsDelivered,
          operatorId: operator,
          monitorId: input.monitorId,
          sameMonitorJustification:
            input.monitorId === operator
              ? trimmedOrNull(input.sameMonitorJustification)
              : null,
        },
      };
    });
  }
}
