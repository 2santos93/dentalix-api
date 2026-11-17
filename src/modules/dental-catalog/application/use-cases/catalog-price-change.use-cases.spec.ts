import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CatalogKind, Prisma } from '@prisma/client';
import {
  ApplyCatalogPriceChangeUseCase,
  GetCatalogPriceHistoryUseCase,
  PreviewCatalogPriceChangeUseCase,
  type PriceChangeRequest,
} from './catalog-price-change.use-cases';
import type {
  AppliedPriceBatch,
  ApplyPriceChangeOutcome,
  CatalogPriceChangeRepository,
  DecidePriceChange,
  PriceChangeIdempotency,
} from '../../domain/ports/catalog-price-change-repository.port';
import type {
  PriceChangeCandidate,
  PriceChangePlan,
} from '../../domain/price-change';
import type { CatalogCurrencyReader } from '../../domain/ports/catalog-currency-reader.port';

const KEY = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';
const ACTOR = '00000000-0000-4000-8000-0000000000aa';

function candidate(code: string, price: string | null): PriceChangeCandidate {
  return {
    id: `00000000-0000-4000-8000-${code.padStart(12, '0')}`,
    code,
    labelEs: code,
    category: 'Prevención',
    kind: CatalogKind.PROCEDURE,
    active: true,
    defaultPrice: price === null ? null : new Prisma.Decimal(price),
  };
}

/** Repositorio en memoria: aplica el plan que decide el caso de uso. */
class InMemoryRepo implements CatalogPriceChangeRepository {
  items = [candidate('1', '1840.00'), candidate('2', '2000.00')];
  batches: (AppliedPriceBatch & { key: string; fingerprint: string })[] = [];
  decided: PriceChangePlan[] = [];

  candidates() {
    return Promise.resolve(this.items.map((i) => ({ ...i })));
  }

  findApplied(idempotency: PriceChangeIdempotency) {
    const found = this.batches.find((b) => b.key === idempotency.key);
    if (!found) return Promise.resolve(null);
    return Promise.resolve(
      found.fingerprint === idempotency.fingerprint
        ? ({ kind: 'replayed', batch: found } as const)
        : ({ kind: 'key-reused' } as const),
    );
  }

  apply(
    idempotency: PriceChangeIdempotency,
    actorUserId: string,
    _criteria: unknown,
    decide: DecidePriceChange,
  ): Promise<ApplyPriceChangeOutcome> {
    const plan = decide(this.items.map((i) => ({ ...i })));
    this.decided.push(plan);
    for (const line of plan.lines) {
      const item = this.items.find((i) => i.id === line.item.id);
      if (item) item.defaultPrice = line.after;
    }
    const batch = {
      id: `batch-${this.batches.length + 1}`,
      actorUserId,
      currency: plan.currency,
      itemCount: plan.lines.length,
      totalBefore: plan.totals.before,
      totalAfter: plan.totals.after,
      createdAt: new Date('2027-01-05T12:00:00Z'),
      key: idempotency.key,
      fingerprint: idempotency.fingerprint,
    };
    this.batches.push(batch);
    return Promise.resolve({ kind: 'applied', batch });
  }

  history(id: string) {
    return Promise.resolve(id === 'missing' ? null : []);
  }
}

const currency: CatalogCurrencyReader = {
  current: () => Promise.resolve('VES'),
};

const request: PriceChangeRequest = {
  category: 'Prevención',
  mode: 'PERCENT',
  value: 5,
  roundTo: 100,
};

describe('DX-205 · casos de uso de «Actualizar precios»', () => {
  let repo: InMemoryRepo;
  let preview: PreviewCatalogPriceChangeUseCase;
  let apply: ApplyCatalogPriceChangeUseCase;

  beforeEach(() => {
    repo = new InMemoryRepo();
    preview = new PreviewCatalogPriceChangeUseCase(repo, currency);
    apply = new ApplyCatalogPriceChangeUseCase(repo, currency);
  });

  it('aplicar escribe exactamente lo que mostró la vista previa (misma función)', async () => {
    const shown = await preview.execute(request);
    const { batch, replayed } = await apply.execute(
      { ...request, previewHash: shown.previewHash },
      ACTOR,
      KEY,
    );
    expect(replayed).toBe(false);
    expect(repo.decided[0].previewHash).toBe(shown.previewHash);
    expect(
      repo.decided[0].lines.map((l) => [l.item.code, l.after.toFixed(2)]),
    ).toEqual(shown.lines.map((l) => [l.item.code, l.after.toFixed(2)]));
    expect(repo.items.map((i) => i.defaultPrice?.toFixed(2))).toEqual([
      '1900.00',
      '2100.00',
    ]);
    expect(batch).toMatchObject({ itemCount: 2, actorUserId: ACTOR });
  });

  it('la misma clave y petición devuelve el lote sin volver a aplicar', async () => {
    const shown = await preview.execute(request);
    const body = { ...request, previewHash: shown.previewHash };
    const first = await apply.execute(body, ACTOR, KEY);
    const second = await apply.execute(body, ACTOR, KEY.toUpperCase());
    expect(second).toEqual({ batch: first.batch, replayed: true });
    expect(repo.batches).toHaveLength(1);
    expect(repo.items[0].defaultPrice?.toFixed(2)).toBe('1900.00');
  });

  it('la misma clave con otra petición: 422 IDEMPOTENCY_KEY_REUSED', async () => {
    const shown = await preview.execute(request);
    await apply.execute(
      { ...request, previewHash: shown.previewHash },
      ACTOR,
      KEY,
    );
    await expect(
      apply.execute(
        { ...request, value: 6, previewHash: shown.previewHash },
        ACTOR,
        KEY,
      ),
    ).rejects.toThrow(UnprocessableEntityException);
  });

  it('si el catálogo cambió desde la vista previa: 409 y nada cambia', async () => {
    const shown = await preview.execute(request);
    repo.items[1].defaultPrice = new Prisma.Decimal('2050.00');
    await expect(
      apply.execute({ ...request, previewHash: shown.previewHash }, ACTOR, KEY),
    ).rejects.toThrow(ConflictException);
    expect(repo.batches).toHaveLength(0);
  });

  it('sin clave o con una que no es UUID: 400', async () => {
    const body = { ...request, previewHash: 'a'.repeat(64) };
    await expect(apply.execute(body, ACTOR, undefined)).rejects.toThrow(
      BadRequestException,
    );
    await expect(apply.execute(body, ACTOR, 'abc')).rejects.toThrow(
      BadRequestException,
    );
  });

  it('reglas que cruzan campos: 0, % fuera de rango, mínimo en una bajada', async () => {
    await expect(preview.execute({ ...request, value: 0 })).rejects.toThrow(
      /no puede ser 0/,
    );
    await expect(preview.execute({ ...request, value: -101 })).rejects.toThrow(
      /entre -100 y 1000/,
    );
    await expect(
      preview.execute({ ...request, value: -5, minIncrement: 1 }),
    ).rejects.toThrow(/solo se aplica a una subida/);
    // Un importe fijo no tiene tope de %.
    await expect(
      preview.execute({ ...request, mode: 'AMOUNT', value: 5000 }),
    ).resolves.toBeDefined();
  });

  it('historial de un ítem que no es de la clínica: 404', async () => {
    const history = new GetCatalogPriceHistoryUseCase(repo);
    await expect(history.execute('missing')).rejects.toThrow(NotFoundException);
    await expect(history.execute('x')).resolves.toEqual([]);
  });
});
