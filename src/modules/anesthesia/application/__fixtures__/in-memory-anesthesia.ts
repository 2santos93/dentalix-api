import { randomUUID } from 'node:crypto';
import type {
  AnesthesiaEntryRef,
  AnesthesiaPatientContext,
  AnesthesiaRecordPrior,
  AnesthesiaRepository,
  AnestheticProductInput,
  AnestheticProductPatch,
  NewAnesthesiaAdministration,
} from '../../domain/ports/anesthesia-repository.port';
import type {
  AnesthesiaAdministration,
  AnestheticProduct,
} from '../../domain/entities';
import type { SampleAnesthetic } from '../../domain/sample-anesthetics';
import {
  type DoseWindow,
  isInDoseWindow,
  type WindowAdministration,
} from '../../domain/anesthesia-window';

/** Repositorio en memoria de una sola clínica para los unit de DX-307. */
export class InMemoryAnesthesiaRepository implements AnesthesiaRepository {
  products: AnestheticProduct[] = [];
  records: AnesthesiaAdministration[] = [];
  patients = new Map<string, AnesthesiaPatientContext>();
  entries = new Map<string, AnesthesiaEntryRef & { patientId: string }>();
  /** Nombres de profesionales y sedes para el desglose (DX-418). */
  authorNames = new Map<string, string>();
  locationNames = new Map<string, string>();
  /** Hojas de sedación (DX-407) por evolución y hora clínica (DX-420). */
  sedations: { patientId: string; entryId: string; at: Date }[] = [];

  listProducts(includeInactive: boolean): Promise<AnestheticProduct[]> {
    return Promise.resolve(
      this.products
        .filter((p) => includeInactive || p.active)
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  }

  findProduct(id: string): Promise<AnestheticProduct | null> {
    return Promise.resolve(this.products.find((p) => p.id === id) ?? null);
  }

  createProduct(
    input: AnestheticProductInput & { sampleCode?: string },
  ): Promise<AnestheticProduct | 'DUPLICATE_NAME'> {
    if (this.products.some((p) => p.name === input.name)) {
      return Promise.resolve('DUPLICATE_NAME');
    }
    const now = new Date();
    const product: AnestheticProduct = {
      id: randomUUID(),
      ...input,
      pediatricMaxMgPerKg: input.pediatricMaxMgPerKg ?? null,
      minAgeYears: input.minAgeYears ?? null,
      epinephrineMgPerCarpule: input.epinephrineMgPerCarpule ?? null,
      sampleCode: input.sampleCode ?? null,
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    this.products.push(product);
    return Promise.resolve(product);
  }

  updateProduct(
    id: string,
    patch: AnestheticProductPatch,
  ): Promise<AnestheticProduct | 'DUPLICATE_NAME' | null> {
    const product = this.products.find((p) => p.id === id);
    if (!product) return Promise.resolve(null);
    if (
      patch.name !== undefined &&
      this.products.some((p) => p.id !== id && p.name === patch.name)
    ) {
      return Promise.resolve('DUPLICATE_NAME');
    }
    Object.assign(product, patch, { updatedAt: new Date() });
    return Promise.resolve(product);
  }

  async createMissingSamples(
    samples: readonly SampleAnesthetic[],
  ): Promise<AnestheticProduct[]> {
    const created: AnestheticProduct[] = [];
    for (const { sampleCode, ...values } of samples) {
      if (this.products.some((p) => p.sampleCode === sampleCode)) continue;
      const product = await this.createProduct({ ...values, sampleCode });
      if (product !== 'DUPLICATE_NAME') created.push(product);
    }
    return created;
  }

  loadPatientContext(patientId: string) {
    return Promise.resolve(this.patients.get(patientId) ?? null);
  }

  findEntry(patientId: string, entryId: string) {
    const entry = this.entries.get(entryId);
    return Promise.resolve(
      entry && entry.patientId === patientId
        ? {
            id: entry.id,
            locationId: entry.locationId,
            timeZone: entry.timeZone,
            sedationWeightKg: entry.sedationWeightKg ?? null,
          }
        : null,
    );
  }

  listByEntry(patientId: string, entryId: string) {
    return Promise.resolve(
      this.records.filter(
        (r) => r.patientId === patientId && r.clinicalEntryId === entryId,
      ),
    );
  }

  listByPatient(patientId: string) {
    return Promise.resolve(
      this.records.filter((r) => r.patientId === patientId),
    );
  }

  listPatientWindow(
    patientId: string,
    window: DoseWindow,
  ): Promise<WindowAdministration[]> {
    return Promise.resolve(
      this.records
        .filter(
          (r) =>
            r.patientId === patientId &&
            isInDoseWindow(r.administeredAt, window),
        )
        .sort((a, b) => a.administeredAt.getTime() - b.administeredAt.getTime())
        .map((r) => ({
          ...r,
          authorName: this.authorNames.get(r.authorId) ?? null,
          locationName: r.locationId
            ? (this.locationNames.get(r.locationId) ?? null)
            : null,
        })),
    );
  }

  hasSedation(patientId: string, entryId: string, range: DoseWindow) {
    return Promise.resolve(
      this.sedations.some(
        (s) =>
          s.patientId === patientId &&
          (s.entryId === entryId || isInDoseWindow(s.at, range)),
      ),
    );
  }

  async record(
    patientId: string,
    entryId: string,
    window: DoseWindow,
    build: (
      prior: AnesthesiaRecordPrior,
    ) => NewAnesthesiaAdministration | Promise<NewAnesthesiaAdministration>,
  ): Promise<AnesthesiaAdministration> {
    const prior: AnesthesiaRecordPrior = {
      entry: await this.listByEntry(patientId, entryId),
      window: await this.listPatientWindow(patientId, window),
    };
    const input = await build(prior);
    const { anesthetic, ...rest } = input;
    const row: AnesthesiaAdministration = {
      id: randomUUID(),
      ...rest,
      anestheticId: anesthetic.id,
      anestheticName: anesthetic.name,
      activeIngredient: anesthetic.activeIngredient,
      concentrationPct: anesthetic.concentrationPct,
      vasoconstrictor: anesthetic.vasoconstrictor,
      mlPerCarpule: anesthetic.mlPerCarpule,
      maxMgPerKg: anesthetic.maxMgPerKg,
      maxAbsoluteMg: anesthetic.maxAbsoluteMg,
      pediatricMaxMgPerKg: anesthetic.pediatricMaxMgPerKg,
      minAgeYears: anesthetic.minAgeYears,
      epinephrineMgPerCarpule: anesthetic.epinephrineMgPerCarpule,
      createdAt: new Date(),
    };
    this.records.push(row);
    return row;
  }
}
