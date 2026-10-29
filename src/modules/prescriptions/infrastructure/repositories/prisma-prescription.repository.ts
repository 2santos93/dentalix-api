/**
 * Excepción G5.3 (DX-334): recetas emitidas antes de DX-324. El repositorio
 * lee el `country` legado de cada fila y, en fase 1, copia en la receta única
 * el de su sede como dato (spec D1, R12). Ninguna regla lo usa.
 */
import { Injectable } from '@nestjs/common';
import { Prisma, PrescriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import { isHourCycle } from '../../../../shared/locations/location-regional';
import type { AllergyMatch } from '../../domain/allergy-match';
import type {
  SafetyAlert,
  SafetyAnamnesis,
  SafetyRule,
  SafetySeverity,
} from '../../domain/prescription-safety';
import type {
  Prescription,
  PrescriptionIssuer,
  PrescriptionPatient,
} from '../../domain/entities/prescription.entity';
import type {
  CreatePrescriptionRepoInput,
  PrescriptionRepository,
  StoredPrescription,
  VoidPrescriptionOutcome,
  VoidPrescriptionRepoInput,
} from '../../domain/ports/prescription-repository.port';

const INCLUDE = {
  items: { orderBy: { position: 'asc' } },
  voidedBy: { select: { fullName: true } },
} satisfies Prisma.PrescriptionInclude;

type Row = Prisma.PrescriptionGetPayload<{ include: typeof INCLUDE }>;

const UNKNOWN_PROFESSIONAL = 'Profesional';

function toDateOnly(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function fromDateOnly(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function readMatches(value: Prisma.JsonValue | null): AllergyMatch[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((m) =>
    m &&
    typeof m === 'object' &&
    !Array.isArray(m) &&
    typeof m.activeIngredient === 'string' &&
    typeof m.allergen === 'string'
      ? [{ activeIngredient: m.activeIngredient, allergen: m.allergen }]
      : [],
  );
}

type JsonRecord = Record<string, Prisma.JsonValue>;

function isRecord(value: Prisma.JsonValue | undefined): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** El campo de texto `key` de cada objeto de una lista JSON de la anamnesis. */
function readNames(
  value: Prisma.JsonValue | null | undefined,
  key: string,
): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) =>
    isRecord(entry) && typeof entry[key] === 'string' ? [entry[key]] : [],
  );
}

/** Peso plausible (kg) de `vitalSigns.peso`; si no, null. */
function readWeight(value: Prisma.JsonValue | null): number | null {
  if (!isRecord(value)) return null;
  const peso = value.peso;
  return typeof peso === 'number' && peso > 0 && peso < 400 ? peso : null;
}

/**
 * DX-300: lo que la receta segura lee de la versión vigente. Las casillas
 * salen de `safetyFlags` (las deriva el servidor al guardar la anamnesis).
 */
function readSafetyAnamnesis(history: {
  allergies: Prisma.JsonValue | null;
  medications: Prisma.JsonValue | null;
  vitalSigns: Prisma.JsonValue | null;
  safetyFlags: Prisma.JsonValue | null;
}): SafetyAnamnesis {
  const flags = isRecord(history.safetyFlags) ? history.safetyFlags : {};
  const flag = (key: string) => flags[key] === true;
  const weeks = flags.semanasEmbarazo;
  return {
    allergens: readNames(history.allergies, 'alergeno'),
    medications: readNames(history.medications, 'nombre'),
    flags: {
      alergiaPenicilina: flag('alergiaPenicilina'),
      alergiaAnestesico: flag('alergiaAnestesico'),
      alergiaLatex: flag('alergiaLatex'),
      embarazo: flag('embarazo'),
      semanasEmbarazo:
        typeof weeks === 'number' && Number.isFinite(weeks) ? weeks : null,
      anticoagulantes: flag('anticoagulantes'),
      bifosfonatos: flag('bifosfonatos'),
    },
    weightKg: readWeight(history.vitalSigns),
  };
}

const SAFETY_RULES: readonly SafetyRule[] = [
  'ALLERGY',
  'INTERACTION',
  'PREGNANCY',
  'ANTIRESORPTIVE',
  'PEDIATRIC_DOSE',
  'NO_ANAMNESIS',
];
const SAFETY_SEVERITIES: readonly SafetySeverity[] = ['BLOCKING', 'INFO'];

/** null = receta anterior a DX-300 (columna NULL). */
function readSafetyAlerts(
  value: Prisma.JsonValue | null,
): SafetyAlert[] | null {
  if (!Array.isArray(value)) return null;
  return value.flatMap((a) => {
    if (!isRecord(a)) return [];
    const rule = SAFETY_RULES.find((r) => r === a.rule);
    const severity = SAFETY_SEVERITIES.find((s) => s === a.severity);
    const { code, message, source, activeIngredient } = a;
    if (
      !rule ||
      !severity ||
      typeof code !== 'string' ||
      typeof message !== 'string' ||
      typeof source !== 'string' ||
      !(activeIngredient === null || typeof activeIngredient === 'string')
    ) {
      return [];
    }
    return [{ rule, code, severity, activeIngredient, message, source }];
  });
}

function mapRow(row: Row): Prescription {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    patientId: row.patientId,
    professionalId: row.professionalId,
    country: row.country,
    singleFormat: row.singleFormat,
    printQuantityInWords: row.printQuantityInWords,
    status: row.status,
    issuedAt: row.issuedAt,
    dispensationDate: toDateOnly(row.dispensationDate),
    validUntil: toDateOnly(row.validUntil),
    patientName: row.patientName,
    patientDocument: row.patientDocument,
    patientBirthYear: row.patientBirthYear,
    patientAgeYears: row.patientAgeYears,
    patientWeightKg: row.patientWeightKg,
    clinicalRecordNumber: row.clinicalRecordNumber,
    professionalName: row.professionalName,
    professionalLicense: row.professionalLicense,
    professionalSpecialty: row.professionalSpecialty,
    professionalEmail: row.professionalEmail,
    clinicName: row.clinicName,
    locationName: row.locationName,
    locationAddress: row.locationAddress,
    notes: row.notes,
    allergyOverride: row.allergyOverride,
    allergyMatches: readMatches(row.allergyMatches),
    safetyRulesVersion: row.safetyRulesVersion,
    safetyAlerts: readSafetyAlerts(row.safetyAlerts),
    safetyOverrideReason: row.safetyOverrideReason,
    contentHash: row.contentHash,
    voidedAt: row.voidedAt,
    voidedById: row.voidedById,
    voidedByName: row.voidedBy?.fullName ?? null,
    voidReason: row.voidReason,
    items: row.items.map((item) => ({
      id: item.id,
      position: item.position,
      activeIngredient: item.activeIngredient,
      brandName: item.brandName,
      concentration: item.concentration,
      pharmaceuticalForm: item.pharmaceuticalForm,
      route: item.route,
      dose: item.dose,
      frequency: item.frequency,
      durationDays: item.durationDays,
      totalQuantity: item.totalQuantity,
      quantityUnit: item.quantityUnit,
      quantityInWords: item.quantityInWords,
      packages: item.packages,
      instructions: item.instructions,
    })),
  };
}

/**
 * Todo corre bajo `runWithTenant` (RLS): una receta, un paciente o una sede de
 * otra clínica no existen para esta. `tenants` y `users` no tienen RLS (tablas
 * globales): se acotan por el tenant del contexto y el usuario del token.
 */
@Injectable()
export class PrismaPrescriptionRepository implements PrescriptionRepository {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  private requireTenantId(): string {
    const tenantId = this.tenantContext.getTenantId();
    if (!tenantId) {
      throw new Error('No tenant in context');
    }
    return tenantId;
  }

  /**
   * Sede del request (X-Location-Id, ya validada contra esta clínica) o, en
   * la vista consolidada, la de escritura de la sesión (la principal, o la
   * primera permitida de un miembro restringido — DX-089): una receta siempre
   * se emite desde UNA sede, que da la dirección y la zona. Los ajustes de
   * receta son de la clínica (spec R3) y el registro y la especialidad, del
   * perfil del miembro.
   */
  loadIssuer(professionalUserId: string): Promise<PrescriptionIssuer> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const locationId = await this.tenantContext.writeLocationId(tx);
      const [location, tenant, user, membership, zoneOf] = await Promise.all([
        tx.location.findFirstOrThrow({
          where: { id: locationId, deletedAt: null },
          select: { id: true, name: true, address: true, country: true },
        }),
        tx.tenant.findFirstOrThrow({
          where: { id: tenantId },
          select: {
            name: true,
            prescriptionPrintQuantityInWords: true,
            prescriptionRequireClinicalRecordNumber: true,
            prescriptionValidityDays: true,
          },
        }),
        tx.user.findFirst({
          where: { id: professionalUserId },
          select: { fullName: true, email: true },
        }),
        tx.clinicMembership.findFirst({
          where: { userId: professionalUserId, deletedAt: null },
          select: { professionalLicense: true, professionalSpecialty: true },
        }),
        resolveLocationTimeZones(tx, tenantId, [locationId]),
      ]);
      const { country, ...site } = location;
      return {
        location: { ...site, timeZone: zoneOf(location.id) },
        clinicName: tenant.name,
        // Fase 1 (spec §4.4, §7): el país legado de la sede, solo para la web
        // anterior a DX-324; la fase 2 lo retira.
        phase1: { country },
        settings: {
          printQuantityInWords: tenant.prescriptionPrintQuantityInWords,
          requireClinicalRecordNumber:
            tenant.prescriptionRequireClinicalRecordNumber,
          validityDays: tenant.prescriptionValidityDays,
        },
        professional: {
          id: professionalUserId,
          name: user?.fullName ?? UNKNOWN_PROFESSIONAL,
          email: user?.email ?? null,
          license: membership?.professionalLicense ?? null,
          specialty: membership?.professionalSpecialty ?? null,
        },
      };
    });
  }

  loadPatient(patientId: string): Promise<PrescriptionPatient | null> {
    return this.prisma.runWithTenant(async (tx) => {
      const patient = await tx.patient.findFirst({
        where: { id: patientId, deletedAt: null },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          documentType: true,
          docTypeLabel: true,
          docNumber: true,
          birthDate: true,
        },
      });
      if (!patient) return null;
      // Anamnesis VIGENTE = la versión más alta (append-only), en la misma
      // transacción con RLS de la clínica que el paciente.
      const history = await tx.medicalHistoryVersion.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: {
          allergies: true,
          medications: true,
          vitalSigns: true,
          safetyFlags: true,
        },
      });
      const { documentType, ...rest } = patient;
      return {
        ...rest,
        docType: documentType,
        anamnesis: history ? readSafetyAnamnesis(history) : null,
      };
    });
  }

  async saveProfessionalLicense(
    userId: string,
    license: string,
  ): Promise<void> {
    await this.prisma.runWithTenant((tx) =>
      tx.clinicMembership.updateMany({
        where: { userId, deletedAt: null },
        data: { professionalLicense: license },
      }),
    );
  }

  async create(input: CreatePrescriptionRepoInput): Promise<Prescription> {
    const tenantId = this.requireTenantId();
    const {
      items,
      allergyMatches,
      safetyAlerts,
      dispensationDate,
      validUntil,
      ...rest
    } = input;
    // Receta y medicamentos en la MISMA transacción: el trigger de la base solo
    // admite medicamentos insertados por la transacción que creó la receta.
    const row = await this.prisma.runWithTenant(async (tx) => {
      // Fase 1 (spec D1, pre-flight I5): las réplicas anteriores leen
      // `country` como no nulo, así que la receta única sigue llevando el país
      // ACTUAL de su sede, leído en esta transacción. Es solo un dato: no
      // entra en el hash v3 ni decide nada. La fase 2 deja de escribirlo.
      const { country } = await tx.location.findFirstOrThrow({
        where: { id: rest.locationId },
        select: { country: true },
      });
      return tx.prescription.create({
        data: {
          ...rest,
          country,
          tenantId,
          dispensationDate: fromDateOnly(dispensationDate),
          validUntil: fromDateOnly(validUntil),
          allergyMatches: allergyMatches as unknown as Prisma.InputJsonValue,
          safetyAlerts: safetyAlerts as unknown as Prisma.InputJsonValue,
          items: { create: items },
        },
        include: INCLUDE,
      });
    });
    return mapRow(row);
  }

  async listByPatient(patientId: string): Promise<Prescription[]> {
    const rows = await this.prisma.runWithTenant((tx) =>
      tx.prescription.findMany({
        where: { patientId },
        orderBy: [{ issuedAt: 'desc' }, { id: 'desc' }],
        include: INCLUDE,
      }),
    );
    return rows.map(mapRow);
  }

  /**
   * Con el formato ACTUAL de la sede de la receta (spec §4.6), también si
   * está retirada (sin filtrar `deletedAt`). Tolerante: lo que falte o no sea
   * válido llega como `null`, nunca un 409; la web pinta «—».
   */
  async findById(id: string): Promise<StoredPrescription | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.prescription.findFirst({
        where: { id },
        include: INCLUDE,
      });
      if (!row) return null;
      const [tenant, location] = await Promise.all([
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { logoUrl: true },
        }),
        tx.location.findFirst({
          where: { id: row.locationId },
          select: { timeZone: true, locale: true, hourCycle: true },
        }),
      ]);
      return {
        ...mapRow(row),
        clinicLogoUrl: tenant?.logoUrl ?? null,
        locationFormat: {
          timeZone: location?.timeZone ?? null,
          locale: location?.locale ?? null,
          hourCycle: isHourCycle(location?.hourCycle)
            ? location.hourCycle
            : null,
        },
      };
    });
  }

  /**
   * `updateMany … WHERE status = 'ISSUED'`: la fila queda bloqueada y una
   * segunda anulación concurrente, al re-evaluar el WHERE, ya no la ve.
   */
  void(
    id: string,
    input: VoidPrescriptionRepoInput,
  ): Promise<VoidPrescriptionOutcome> {
    return this.prisma.runWithTenant(async (tx) => {
      const { count } = await tx.prescription.updateMany({
        where: { id, status: PrescriptionStatus.ISSUED },
        data: {
          status: PrescriptionStatus.VOIDED,
          voidedAt: input.voidedAt,
          voidedById: input.voidedById,
          voidReason: input.reason,
        },
      });
      const row = await tx.prescription.findFirst({
        where: { id },
        include: INCLUDE,
      });
      if (!row) return { kind: 'NOT_FOUND' };
      if (count === 0) return { kind: 'ALREADY_VOIDED' };
      return { kind: 'VOIDED', prescription: mapRow(row) };
    });
  }
}
