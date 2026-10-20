import { Injectable } from '@nestjs/common';
import { Prisma, PrescriptionStatus } from '@prisma/client';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import { resolveLocationTimeZones } from '../../../../shared/locations/location-time-zone';
import type { AllergyMatch } from '../../domain/allergy-match';
import type {
  Prescription,
  PrescriptionIssuer,
  PrescriptionPatient,
} from '../../domain/entities/prescription.entity';
import type {
  CreatePrescriptionRepoInput,
  PrescriptionRepository,
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

/** `alergeno` de cada alergia de la anamnesis (JSON validado al guardarla). */
function readAllergens(value: Prisma.JsonValue | null | undefined): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((a) =>
    a &&
    typeof a === 'object' &&
    !Array.isArray(a) &&
    typeof a.alergeno === 'string'
      ? [a.alergeno]
      : [],
  );
}

function mapRow(row: Row): Prescription {
  return {
    id: row.id,
    tenantId: row.tenantId,
    locationId: row.locationId,
    patientId: row.patientId,
    professionalId: row.professionalId,
    country: row.country,
    status: row.status,
    issuedAt: row.issuedAt,
    dispensationDate: toDateOnly(row.dispensationDate),
    validUntil: toDateOnly(row.validUntil),
    patientName: row.patientName,
    patientDocument: row.patientDocument,
    patientBirthYear: row.patientBirthYear,
    clinicalRecordNumber: row.clinicalRecordNumber,
    professionalName: row.professionalName,
    professionalLicense: row.professionalLicense,
    professionalEmail: row.professionalEmail,
    clinicName: row.clinicName,
    locationName: row.locationName,
    locationAddress: row.locationAddress,
    notes: row.notes,
    allergyOverride: row.allergyOverride,
    allergyMatches: readMatches(row.allergyMatches),
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
   * se emite desde UNA sede, que da el país y la dirección.
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
        tx.tenant.findFirst({
          where: { id: tenantId },
          select: { name: true },
        }),
        tx.user.findFirst({
          where: { id: professionalUserId },
          select: { fullName: true, email: true },
        }),
        tx.clinicMembership.findFirst({
          where: { userId: professionalUserId, deletedAt: null },
          select: { professionalLicense: true },
        }),
        resolveLocationTimeZones(tx, tenantId, [locationId]),
      ]);
      return {
        location: { ...location, timeZone: zoneOf(location.id) },
        clinicName: tenant?.name ?? '',
        professional: {
          id: professionalUserId,
          name: user?.fullName ?? UNKNOWN_PROFESSIONAL,
          email: user?.email ?? null,
          license: membership?.professionalLicense ?? null,
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
          docType: true,
          docNumber: true,
          birthDate: true,
        },
      });
      if (!patient) return null;
      // Anamnesis VIGENTE = la versión más alta (append-only).
      const history = await tx.medicalHistoryVersion.findFirst({
        where: { patientId, deletedAt: null },
        orderBy: { version: 'desc' },
        select: { allergies: true },
      });
      return { ...patient, allergies: readAllergens(history?.allergies) };
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
    const { items, allergyMatches, dispensationDate, validUntil, ...rest } =
      input;
    // Receta y medicamentos en la MISMA transacción: el trigger de la base solo
    // admite medicamentos insertados por la transacción que creó la receta.
    const row = await this.prisma.runWithTenant((tx) =>
      tx.prescription.create({
        data: {
          ...rest,
          tenantId,
          dispensationDate: fromDateOnly(dispensationDate),
          validUntil: fromDateOnly(validUntil),
          allergyMatches: allergyMatches as unknown as Prisma.InputJsonValue,
          items: { create: items },
        },
        include: INCLUDE,
      }),
    );
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

  async findById(
    id: string,
  ): Promise<(Prescription & { clinicLogoUrl: string | null }) | null> {
    const tenantId = this.requireTenantId();
    return this.prisma.runWithTenant(async (tx) => {
      const row = await tx.prescription.findFirst({
        where: { id },
        include: INCLUDE,
      });
      if (!row) return null;
      const tenant = await tx.tenant.findFirst({
        where: { id: tenantId },
        select: { logoUrl: true },
      });
      return { ...mapRow(row), clinicLogoUrl: tenant?.logoUrl ?? null };
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
