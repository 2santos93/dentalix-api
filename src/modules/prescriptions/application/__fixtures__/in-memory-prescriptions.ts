import { PrescriptionStatus } from '@prisma/client';
import type {
  Prescription,
  PrescriptionIssuer,
  PrescriptionLocationFormat,
  PrescriptionPatient,
} from '../../domain/entities/prescription.entity';
import type { LegacyPrescriptionCountry } from '../../domain/legacy-prescription';
import type { PrescriptionSettings } from '../../domain/prescription-settings';
import type {
  CreatePrescriptionRepoInput,
  PrescriptionRepository,
  StoredPrescription,
  VoidPrescriptionOutcome,
  VoidPrescriptionRepoInput,
} from '../../domain/ports/prescription-repository.port';
import { emptySafetyAnamnesis } from '../../domain/prescription-safety';
import type { PrescriptionTemplate } from '../../domain/entities/prescription-template.entity';
import type {
  PrescriptionTemplateRepoInput,
  PrescriptionTemplateRepository,
} from '../../domain/ports/prescription-template-repository.port';

export const TENANT_ID = '00000000-0000-4000-8000-000000000001';
export const DENTIST_ID = '00000000-0000-4000-8000-0000000000d1';
export const OTHER_DENTIST_ID = '00000000-0000-4000-8000-0000000000d2';
export const PATIENT_ID = '00000000-0000-4000-8000-0000000000a1';

/** Ajustes de la clínica de los tests: letras y nº de HC encendidos, 30 días. */
export const TEST_PRESCRIPTION_SETTINGS: PrescriptionSettings = {
  printQuantityInWords: true,
  requireClinicalRecordNumber: true,
  validityDays: 30,
};

export function makeIssuer(
  overrides: Partial<PrescriptionIssuer['location']> = {},
  license: string | null = 'RM-12345',
  extra: {
    settings?: Partial<PrescriptionSettings>;
    specialty?: string | null;
  } = {},
): PrescriptionIssuer {
  return {
    location: {
      id: '00000000-0000-4000-8000-0000000000l1',
      name: 'Sede Principal',
      address: 'Avenida Central 100',
      timeZone: 'America/New_York',
      ...overrides,
    },
    clinicName: 'Clínica Demo',
    settings: { ...TEST_PRESCRIPTION_SETTINGS, ...extra.settings },
    phase1: { country: 'CO' },
    professional: {
      id: DENTIST_ID,
      name: 'Dra. Laura Ruiz',
      email: 'laura@example.com',
      license,
      specialty: extra.specialty ?? null,
    },
  };
}

export function makePatient(
  overrides: Partial<PrescriptionPatient> = {},
): PrescriptionPatient {
  return {
    id: PATIENT_ID,
    firstName: 'Ana',
    lastName: 'Pérez Gómez',
    docType: 'CC',
    docNumber: '1020304050',
    birthDate: new Date('1985-03-02T00:00:00.000Z'),
    anamnesis: emptySafetyAnamnesis(),
    ...overrides,
  };
}

export class InMemoryPrescriptionRepository implements PrescriptionRepository {
  issuer: PrescriptionIssuer = makeIssuer();
  patients = new Map<string, PrescriptionPatient>([
    [PATIENT_ID, makePatient()],
  ]);
  rows: Prescription[] = [];
  /** Lo último que el caso de uso pidió insertar, tal cual. */
  lastCreateInput: CreatePrescriptionRepoInput | null = null;
  /**
   * Fase 1 (spec D1): como el repositorio real, la fila lleva el país de la
   * sede como dato (la columna legada no admite NULL); el caso de uso no lo
   * conoce y ningún test que no sea legado lo cambia.
   */
  locationCountry: LegacyPrescriptionCountry = 'CO';
  savedLicenses: { userId: string; license: string }[] = [];
  userNames = new Map<string, string>([
    [DENTIST_ID, 'Dra. Laura Ruiz'],
    [OTHER_DENTIST_ID, 'Dr. Otro'],
  ]);
  private seq = 0;

  loadIssuer(professionalUserId: string): Promise<PrescriptionIssuer> {
    return Promise.resolve({
      ...this.issuer,
      professional: { ...this.issuer.professional, id: professionalUserId },
    });
  }

  loadPatient(patientId: string): Promise<PrescriptionPatient | null> {
    return Promise.resolve(this.patients.get(patientId) ?? null);
  }

  saveProfessionalLicense(userId: string, license: string): Promise<void> {
    this.savedLicenses.push({ userId, license });
    return Promise.resolve();
  }

  create(input: CreatePrescriptionRepoInput): Promise<Prescription> {
    this.lastCreateInput = structuredClone(input);
    this.seq += 1;
    const id = `00000000-0000-4000-8000-${String(this.seq).padStart(12, '0')}`;
    const row: Prescription = {
      ...input,
      country: this.locationCountry,
      id,
      tenantId: TENANT_ID,
      status: PrescriptionStatus.ISSUED,
      voidedAt: null,
      voidedById: null,
      voidedByName: null,
      voidReason: null,
      items: input.items.map((item, i) => ({ ...item, id: `${id}-${i}` })),
    };
    this.rows.push(row);
    return Promise.resolve(structuredClone(row));
  }

  listByPatient(patientId: string): Promise<Prescription[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => r.patientId === patientId)
        .sort((a, b) => b.issuedAt.getTime() - a.issuedAt.getTime()),
    );
  }

  /** Formato actual de cada sede, por id; sin entrada, todo `null`. */
  locationFormats = new Map<string, PrescriptionLocationFormat>();

  findById(id: string): Promise<StoredPrescription | null> {
    const row = this.rows.find((r) => r.id === id);
    return Promise.resolve(
      row
        ? {
            ...structuredClone(row),
            clinicLogoUrl: null,
            locationFormat: this.locationFormats.get(row.locationId) ?? {
              timeZone: null,
              locale: null,
              hourCycle: null,
            },
          }
        : null,
    );
  }

  void(
    id: string,
    input: VoidPrescriptionRepoInput,
  ): Promise<VoidPrescriptionOutcome> {
    const row = this.rows.find((r) => r.id === id);
    if (!row) return Promise.resolve({ kind: 'NOT_FOUND' });
    if (row.status === PrescriptionStatus.VOIDED) {
      return Promise.resolve({ kind: 'ALREADY_VOIDED' });
    }
    row.status = PrescriptionStatus.VOIDED;
    row.voidedAt = input.voidedAt;
    row.voidedById = input.voidedById;
    row.voidedByName = this.userNames.get(input.voidedById) ?? null;
    row.voidReason = input.reason;
    return Promise.resolve({
      kind: 'VOIDED',
      prescription: structuredClone(row),
    });
  }
}

export class InMemoryPrescriptionTemplateRepository implements PrescriptionTemplateRepository {
  rows: (PrescriptionTemplate & { deleted: boolean })[] = [];
  private seq = 0;

  list(): Promise<PrescriptionTemplate[]> {
    return Promise.resolve(
      this.rows
        .filter((r) => !r.deleted)
        .sort((a, b) => a.name.localeCompare(b.name, 'es')),
    );
  }

  findById(id: string): Promise<PrescriptionTemplate | null> {
    return Promise.resolve(
      this.rows.find((r) => r.id === id && !r.deleted) ?? null,
    );
  }

  create(input: PrescriptionTemplateRepoInput): Promise<PrescriptionTemplate> {
    this.seq += 1;
    const row = {
      ...input,
      id: `t${this.seq}`,
      tenantId: TENANT_ID,
      createdAt: new Date(),
      updatedAt: new Date(),
      deleted: false,
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  update(
    id: string,
    input: Partial<PrescriptionTemplateRepoInput>,
  ): Promise<PrescriptionTemplate> {
    const row = this.rows.find((r) => r.id === id)!;
    Object.assign(row, input, { updatedAt: new Date() });
    return Promise.resolve(row);
  }

  softDelete(id: string): Promise<void> {
    this.rows.find((r) => r.id === id)!.deleted = true;
    return Promise.resolve();
  }
}
