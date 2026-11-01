import type { PayerType } from '../../../payers/domain/payer-type';
import { Agreement } from '../../domain/entities/agreement.entity';
import {
  AgreementRepository,
  CreateAgreementRepoInput,
  RetireAgreementResult,
  UpdateAgreementRepoInput,
} from '../../domain/ports/agreement-repository.port';
import { agreementNameKey } from '../../domain/agreement-rules';

/**
 * Repositorio de convenios en memoria con estado: los tests afirman sobre
 * `rows` y `patch` igual que un e2e lo haría sobre la tabla. `deleted` guarda
 * los retirados. `payers` y `priceLists` resuelven el nombre de la relación
 * (en la BD lo hace el `include`).
 */
export class InMemoryAgreementRepository implements AgreementRepository {
  readonly rows: Agreement[] = [];
  readonly deleted = new Set<string>();
  readonly liveAssignments = new Map<string, number>();
  readonly payers = new Map<string, string>();
  /** Tipo del pagador por id; sin entrada, PUBLIC_SYSTEM. */
  readonly payerTypes = new Map<string, PayerType>();
  readonly priceLists = new Map<string, { name: string; currency: string }>();
  /** Último parche recibido por `update`, para afirmar qué columnas se tocan. */
  lastPatch: UpdateAgreementRepoInput | null = null;
  private nextId = 1;

  seed(partial: Partial<Agreement> = {}): Agreement {
    const row: Agreement = {
      id: `agreement-${this.nextId++}`,
      name: 'Convenio base',
      payer: { id: 'payer-1', name: 'Sanavida', type: 'PUBLIC_SYSTEM' },
      kind: 'PERCENT_DISCOUNT',
      percent: 10,
      percentByCategory: null,
      priceList: null,
      locationId: null,
      validFrom: null,
      validTo: null,
      active: true,
      assignedCount: 0,
      createdAt: new Date('2026-10-01T00:00:00.000Z'),
      updatedAt: new Date('2026-10-01T00:00:00.000Z'),
      ...partial,
    };
    this.rows.push(row);
    return row;
  }

  private payerOf(id: string): Agreement['payer'] {
    return {
      id,
      name: this.payers.get(id) ?? 'Pagador',
      type: this.payerTypes.get(id) ?? 'PUBLIC_SYSTEM',
    };
  }

  private live(): Agreement[] {
    return this.rows.filter((r) => !this.deleted.has(r.id));
  }

  list(params: { includeInactive: boolean }): Promise<Agreement[]> {
    return Promise.resolve(
      this.live()
        .filter((r) => params.includeInactive || r.active)
        .sort((a, b) => a.name.localeCompare(b.name, 'es'))
        .map((r) => ({ ...r })),
    );
  }

  findById(id: string): Promise<Agreement | null> {
    const row = this.live().find((r) => r.id === id);
    return Promise.resolve(row ? { ...row } : null);
  }

  findLiveById(id: string): Promise<Agreement | null> {
    return this.findById(id);
  }

  findByNormalizedName(
    nameKey: string,
    excludeId?: string,
  ): Promise<Agreement | null> {
    const row = this.live().find(
      (r) => r.id !== excludeId && agreementNameKey(r.name) === nameKey,
    );
    return Promise.resolve(row ? { ...row } : null);
  }

  create(input: CreateAgreementRepoInput): Promise<Agreement> {
    const list = input.priceListId
      ? this.priceLists.get(input.priceListId)
      : undefined;
    return Promise.resolve(
      this.seed({
        name: input.name,
        payer: this.payerOf(input.payerId),
        kind: input.kind,
        percent: input.percent,
        percentByCategory: input.percentByCategory,
        priceList:
          input.priceListId && list ? { id: input.priceListId, ...list } : null,
        locationId: input.locationId,
        validFrom: input.validFrom,
        validTo: input.validTo,
        active: input.active,
      }),
    );
  }

  update(
    id: string,
    patch: UpdateAgreementRepoInput,
  ): Promise<Agreement | null> {
    this.lastPatch = patch;
    const row = this.live().find((r) => r.id === id);
    if (!row) return Promise.resolve(null);
    if (patch.name !== undefined) row.name = patch.name;
    if (patch.payerId !== undefined) {
      row.payer = this.payerOf(patch.payerId);
    }
    if (patch.kind !== undefined) row.kind = patch.kind;
    if (patch.percent !== undefined) row.percent = patch.percent;
    if (patch.percentByCategory !== undefined) {
      row.percentByCategory = patch.percentByCategory;
    }
    if (patch.priceListId !== undefined) {
      const list = patch.priceListId
        ? this.priceLists.get(patch.priceListId)
        : undefined;
      row.priceList =
        patch.priceListId && list ? { id: patch.priceListId, ...list } : null;
    }
    if (patch.locationId !== undefined) row.locationId = patch.locationId;
    if (patch.validFrom !== undefined) row.validFrom = patch.validFrom;
    if (patch.validTo !== undefined) row.validTo = patch.validTo;
    if (patch.active !== undefined) row.active = patch.active;
    return Promise.resolve({ ...row });
  }

  retire(id: string): Promise<RetireAgreementResult> {
    const row = this.live().find((r) => r.id === id);
    if (!row) return Promise.resolve('NOT_FOUND');
    if ((this.liveAssignments.get(id) ?? 0) > 0) {
      return Promise.resolve('IN_USE');
    }
    this.deleted.add(id);
    row.active = false;
    return Promise.resolve('RETIRED');
  }
}
