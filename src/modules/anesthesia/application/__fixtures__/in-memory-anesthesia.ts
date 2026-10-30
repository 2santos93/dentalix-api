import { randomUUID } from 'node:crypto';
import type {
  AnesthesiaEntryRef,
  AnesthesiaPatientContext,
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

/** Repositorio en memoria de una sola clínica para los unit de DX-307. */
export class InMemoryAnesthesiaRepository implements AnesthesiaRepository {
  products: AnestheticProduct[] = [];
  records: AnesthesiaAdministration[] = [];
  patients = new Map<string, AnesthesiaPatientContext>();
  entries = new Map<string, AnesthesiaEntryRef & { patientId: string }>();

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

  async record(
    patientId: string,
    entryId: string,
    build: (
      prior: AnesthesiaAdministration[],
    ) => NewAnesthesiaAdministration | Promise<NewAnesthesiaAdministration>,
  ): Promise<AnesthesiaAdministration> {
    const input = await build(await this.listByEntry(patientId, entryId));
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
      createdAt: new Date(),
    };
    this.records.push(row);
    return row;
  }
}
