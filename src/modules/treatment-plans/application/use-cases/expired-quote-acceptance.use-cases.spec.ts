import {
  BadRequestException,
  ConflictException,
  type HttpException,
} from '@nestjs/common';
import { ClinicRole, TreatmentPlanStatus } from '@prisma/client';
import { FixedDocumentTypeNamesReader } from '../../../document-type-names/__fixtures__/fixed-document-type-names.reader';
import {
  EXPIRED_NOT_EXPIRED_MESSAGE,
  EXPIRED_NOTE_REQUIRED_MESSAGE,
  EXPIRED_REASON_REQUIRED_MESSAGE,
  QUOTE_EXPIRED_CODE,
} from '../../domain/expired-quote-acceptance';
import type { RepricingSubject } from '../../domain/ports/plan-repricing-repository.port';
import type { PlanQuoteSource } from '../../domain/ports/plan-quote-repository.port';
import {
  REPRICE_STALE_CODE,
  REPRICE_STALE_MESSAGE,
  repricingConflict,
  type ItemPriceState,
  type Repricing,
} from '../repricing';
import {
  InMemoryPlanQuoteRepository,
  quoteSource,
} from './__fixtures__/in-memory-plan-quote.repository';
import {
  AcceptTreatmentPlanUseCase,
  GetPlanQuoteUseCase,
  PreviewAcceptanceRepricingUseCase,
  QUOTE_CHANGED_MESSAGE,
  type AcceptTreatmentPlanInput,
} from './plan-quote.use-cases';
import type {
  AcceptanceRepricer,
  AcceptanceRepricingContext,
} from './plan-repricing.use-cases';

// DX-379 (porción C): aceptar en la clínica un presupuesto vencido.

const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
// 16/10/2026 10:00 en Caracas (UTC-4).
const NOW = new Date('2026-10-16T14:00:00.000Z');
const META = {
  acceptedById: 'user-1',
  role: ClinicRole.DENTIST,
  ipAddress: '10.0.0.1',
  userAgent: 'jest',
};
const PREVIEW_HASH = 'b'.repeat(64);
const RENEWED = { issuedOn: '2026-10-16', validUntil: '2026-11-15' };

let names: FixedDocumentTypeNamesReader;
beforeEach(() => {
  names = new FixedDocumentTypeNamesReader();
});

/** Plan presentado con su validez guardada (vence el 1/10: vencido el 16/10). */
function presented(validUntil = '2026-10-01', issuedOn = '2026-09-01') {
  return quoteSource({
    plan: {
      ...quoteSource().plan,
      status: TreatmentPlanStatus.PRESENTED,
      quoteIssuedOn: issuedOn,
      quoteValidUntil: validUntil,
      presentedLocationId: 'loc-1',
    },
  });
}

function state(price: number, discount: number): ItemPriceState {
  return {
    catalogPrice: price,
    basePrice: price,
    catalogCurrency: 'USD',
    priceSource: 'CATALOG',
    agreementId: null,
    agreementName: null,
    pricingLocationId: 'loc-1',
    reference: {
      referenceCurrency: 'USD',
      referencePriceInPlan: price,
      basePriceInPlan: price,
      referenceRate: null,
    },
    price,
    discount,
    discountReason: null,
    discountReasonNote: null,
    discountById: null,
    discountAt: null,
    discountLocationId: null,
  };
}

/** Recotización de prueba: item-1 a 4.000.000 (−10 %) e item-2 a 200.000. */
function repricing(source: PlanQuoteSource): Repricing {
  const after: Record<string, ItemPriceState> = {
    'item-1': state(4000000, 400000),
    'item-2': state(200000, 0),
  };
  return {
    planId: source.plan.id,
    currency: 'USD',
    lines: source.items.map((item) => ({
      itemId: item.id,
      catalogItemId: `cat-${item.id}`,
      toothNumber: item.toothNumber,
      before: state(item.price, item.discount),
      after: after[item.id],
      changed: true,
    })),
    skipped: [],
    rate: null,
    previousValidity: {
      issuedOn: source.plan.quoteIssuedOn!,
      validUntil: source.plan.quoteValidUntil!,
    },
    validityRenewed: true,
    validityNote: null,
    validity: RENEWED,
    totals: { before: 3330000, after: 3800000 },
    previewHash: PREVIEW_HASH,
  };
}

/**
 * El recotizador de la firma (su `decide` real está en
 * plan-repricing.use-cases.spec.ts): aquí, la huella de la vista previa
 * tiene que ser PREVIEW_HASH.
 */
function stubRepricer() {
  const reads: unknown[] = [];
  const repricer = {
    read: (...args: unknown[]) => {
      reads.push(args);
      return Promise.resolve({} as AcceptanceRepricingContext);
    },
    decide: (
      _context: AcceptanceRepricingContext,
      subject: RepricingSubject,
      previewHash: string | null,
    ) => {
      if (previewHash !== null && previewHash !== PREVIEW_HASH) {
        throw repricingConflict(REPRICE_STALE_CODE, REPRICE_STALE_MESSAGE);
      }
      return repricing(subject as unknown as PlanQuoteSource);
    },
  };
  return { repricer: repricer as unknown as AcceptanceRepricer, reads };
}

function setup(source: PlanQuoteSource = presented()) {
  const repo = new InMemoryPlanQuoteRepository();
  repo.add(source);
  // El fake pasa el presupuesto leído como «sujeto»: el stub solo lo usa
  // para construir las líneas.
  repo.subjectFor = (s) => s as unknown as RepricingSubject;
  const clock = () => NOW;
  const { repricer, reads } = stubRepricer();
  return {
    repo,
    reads,
    get: new GetPlanQuoteUseCase(repo, clock, names),
    accept: new AcceptTreatmentPlanUseCase(
      repo,
      clock,
      names,
      'current',
      repricer,
    ),
    preview: new PreviewAcceptanceRepricingUseCase(
      repo,
      clock,
      names,
      repricer,
    ),
  };
}

async function input(
  ctx: ReturnType<typeof setup>,
  expired?: AcceptTreatmentPlanInput['expired'],
): Promise<AcceptTreatmentPlanInput> {
  const shown = await ctx.get.execute('patient-1', 'plan-1');
  return {
    signerName: 'Ana Pérez',
    signature: PNG,
    contentHash: shown.contentHash,
    expired,
  };
}

async function rejection(promise: Promise<unknown>): Promise<HttpException> {
  try {
    await promise;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('no lanzó');
}

describe('AcceptTreatmentPlanUseCase: presupuesto vencido (DX-379 C)', () => {
  it('no vencido y sin `expired`: acepta como siempre y copia la validez', async () => {
    const ctx = setup(presented('2026-10-20'));
    const doc = await ctx.accept.execute(
      'patient-1',
      'plan-1',
      await input(ctx),
      META,
    );
    expect(doc.planStatus).toBe(TreatmentPlanStatus.ACCEPTED);
    expect(ctx.repo.inserted[0].expiry).toEqual({
      quoteValidUntil: '2026-10-20',
      mode: null,
      reason: null,
      note: null,
      repricingId: null,
    });
    expect(doc.acceptance).toMatchObject({
      quoteValidUntil: '2026-10-20',
      expiredMode: null,
    });
  });

  it('el último día válido todavía vale (vence el día siguiente en la sede)', async () => {
    const ctx = setup(presented('2026-10-16'));
    await expect(
      ctx.accept.execute('patient-1', 'plan-1', await input(ctx), META),
    ).resolves.toMatchObject({ planStatus: TreatmentPlanStatus.ACCEPTED });
  });

  it('vencido sin elegir cómo: 409 QUOTE_EXPIRED con la fecha de la sede y nada se escribe', async () => {
    const ctx = setup();
    const error = await rejection(
      ctx.accept.execute('patient-1', 'plan-1', await input(ctx), META),
    );
    expect(error).toBeInstanceOf(ConflictException);
    expect(error.getResponse()).toEqual({
      statusCode: 409,
      error: 'Conflict',
      code: QUOTE_EXPIRED_CODE,
      message:
        'El presupuesto venció el 01/10/2026. Actualiza los precios o acepta con los precios originales indicando el motivo.',
      quoteValidUntil: '2026-10-01',
    });
    expect(ctx.repo.inserted).toHaveLength(0);
    expect(ctx.repo.sources.get('plan-1')!.plan.status).toBe(
      TreatmentPlanStatus.PRESENTED,
    );
  });

  it('se decide con el día de la sede del plan, no con UTC', async () => {
    // 17/10 01:00 UTC = 16/10 21:00 en Caracas: el 16/10 todavía vale.
    const ctx = setup(presented('2026-10-16'));
    const accept = new AcceptTreatmentPlanUseCase(
      ctx.repo,
      () => new Date('2026-10-17T01:00:00.000Z'),
      names,
    );
    const shown = await new GetPlanQuoteUseCase(
      ctx.repo,
      () => new Date('2026-10-17T01:00:00.000Z'),
      names,
    ).execute('patient-1', 'plan-1');
    await expect(
      accept.execute(
        'patient-1',
        'plan-1',
        { signerName: 'Ana', signature: PNG, contentHash: shown.contentHash },
        META,
      ),
    ).resolves.toMatchObject({ planStatus: TreatmentPlanStatus.ACCEPTED });
  });

  it('sin zona válida en la sede de la presentación: 409 de zona (nunca otra zona)', async () => {
    const source = presented();
    const ctx = setup({
      ...source,
      plan: { ...source.plan, quoteTimeZone: null },
    });
    const error = await rejection(
      ctx.accept.execute('patient-1', 'plan-1', await input(ctx), META),
    );
    expect(error.getResponse()).toMatchObject({
      code: 'LOCATION_TIMEZONE_REQUIRED',
    });
  });

  it('precios originales sin motivo, u OTHER sin nota: 400 antes de tocar la base', async () => {
    const ctx = setup();
    const noReason = await rejection(
      ctx.accept.execute(
        'patient-1',
        'plan-1',
        await input(ctx, { mode: 'ORIGINAL_PRICES' }),
        META,
      ),
    );
    expect(noReason).toBeInstanceOf(BadRequestException);
    expect(noReason.message).toBe(EXPIRED_REASON_REQUIRED_MESSAGE);
    const noNote = await rejection(
      ctx.accept.execute(
        'patient-1',
        'plan-1',
        await input(ctx, { mode: 'ORIGINAL_PRICES', reason: 'OTHER' }),
        META,
      ),
    );
    expect(noNote).toBeInstanceOf(BadRequestException);
    expect(noNote.message).toBe(EXPIRED_NOTE_REQUIRED_MESSAGE);
    expect(ctx.repo.inserted).toHaveLength(0);
  });

  it('elegir cómo con un presupuesto NO vencido: 400 (ORIGINAL_PRICES y REPRICE)', async () => {
    for (const expired of [
      { mode: 'ORIGINAL_PRICES' as const, reason: 'LOYALTY' as const },
      { mode: 'REPRICE' as const, repricePreviewHash: PREVIEW_HASH },
    ]) {
      const ctx = setup(presented('2026-10-20'));
      const error = await rejection(
        ctx.accept.execute(
          'patient-1',
          'plan-1',
          await input(ctx, expired),
          META,
        ),
      );
      expect(error).toBeInstanceOf(BadRequestException);
      expect(error.message).toBe(EXPIRED_NOT_EXPIRED_MESSAGE);
      expect(ctx.repo.inserted).toHaveLength(0);
      expect(ctx.repo.repricings).toHaveLength(0);
    }
  });

  it('precios originales con motivo: firma el presupuesto vencido y guarda modo, motivo, nota y la validez', async () => {
    const ctx = setup();
    const doc = await ctx.accept.execute(
      'patient-1',
      'plan-1',
      await input(ctx, {
        mode: 'ORIGINAL_PRICES',
        reason: 'OTHER',
        note: '  Promesa de la directora ',
      }),
      META,
    );
    expect(doc.planStatus).toBe(TreatmentPlanStatus.ACCEPTED);
    // Los precios y las fechas firmadas son las del presupuesto vencido.
    expect(doc.validUntil).toBe('2026-10-01');
    expect(doc.items.map((i) => i.unitPrice)).toEqual([3500000, 180000]);
    expect(ctx.repo.inserted[0].expiry).toEqual({
      quoteValidUntil: '2026-10-01',
      mode: 'ORIGINAL_PRICES',
      reason: 'OTHER',
      note: 'Promesa de la directora',
      repricingId: null,
    });
    expect(doc.acceptance).toMatchObject({
      integrityOk: true,
      quoteValidUntil: '2026-10-01',
      expiredMode: 'ORIGINAL_PRICES',
      expiredReason: 'OTHER',
      expiredNote: 'Promesa de la directora',
      repricingId: null,
    });
  });

  describe('actualizar los precios (REPRICE)', () => {
    it('la vista previa compone el presupuesto recotizado sin escribir nada', async () => {
      const ctx = setup();
      const { repricing: r, quote } = await ctx.preview.execute(
        'patient-1',
        'plan-1',
        { userId: 'user-1', role: ClinicRole.DENTIST },
      );
      expect(r.previewHash).toBe(PREVIEW_HASH);
      expect(quote.items.map((i) => i.unitPrice)).toEqual([4000000, 200000]);
      expect(quote.issuedOn).toBe(RENEWED.issuedOn);
      expect(quote.validUntil).toBe(RENEWED.validUntil);
      expect(quote.acceptance).toBeNull();
      expect(ctx.repo.repricings).toHaveLength(0);
      expect(ctx.repo.sources.get('plan-1')!.items[0].price).toBe(3500000);
    });

    it('con la huella y el contentHash de la vista previa: recotiza y firma el presupuesto nuevo en una sola operación', async () => {
      const ctx = setup();
      const { quote } = await ctx.preview.execute('patient-1', 'plan-1', {
        userId: 'user-1',
        role: ClinicRole.DENTIST,
      });
      const doc = await ctx.accept.execute(
        'patient-1',
        'plan-1',
        {
          signerName: 'Ana Pérez',
          signature: PNG,
          contentHash: quote.contentHash,
          expired: { mode: 'REPRICE', repricePreviewHash: PREVIEW_HASH },
        },
        META,
      );
      expect(doc.contentHash).toBe(quote.contentHash);
      expect(doc.items.map((i) => i.unitPrice)).toEqual([4000000, 200000]);
      expect(doc.validUntil).toBe(RENEWED.validUntil);
      expect(ctx.repo.repricings).toHaveLength(1);
      expect(ctx.repo.inserted[0].expiry).toEqual({
        quoteValidUntil: '2026-10-01',
        mode: 'REPRICE',
        reason: null,
        note: null,
        repricingId: 'repricing-1',
      });
      expect(doc.acceptance).toMatchObject({
        expiredMode: 'REPRICE',
        repricingId: 'repricing-1',
        quoteValidUntil: '2026-10-01',
        integrityOk: true,
      });
      // Los precios vigentes se leyeron al instante de la firma.
      expect(ctx.reads.at(-1)).toEqual([
        'patient-1',
        'plan-1',
        { userId: 'user-1', role: ClinicRole.DENTIST },
        NOW,
      ]);
    });

    it('con la huella de la vista previa obsoleta: 409 REPRICE_PREVIEW_STALE y nada escrito', async () => {
      const ctx = setup();
      const { quote } = await ctx.preview.execute('patient-1', 'plan-1', {
        userId: 'user-1',
        role: ClinicRole.DENTIST,
      });
      const error = await rejection(
        ctx.accept.execute(
          'patient-1',
          'plan-1',
          {
            signerName: 'Ana Pérez',
            signature: PNG,
            contentHash: quote.contentHash,
            expired: { mode: 'REPRICE', repricePreviewHash: 'c'.repeat(64) },
          },
          META,
        ),
      );
      expect(error.getResponse()).toMatchObject({ code: REPRICE_STALE_CODE });
      expect(ctx.repo.repricings).toHaveLength(0);
      expect(ctx.repo.inserted).toHaveLength(0);
      expect(ctx.repo.sources.get('plan-1')!.items[0].price).toBe(3500000);
    });

    it('con el contentHash del presupuesto VIEJO: 409 QUOTE_CHANGED y la recotización se deshace', async () => {
      const ctx = setup();
      const error = await rejection(
        ctx.accept.execute(
          'patient-1',
          'plan-1',
          await input(ctx, {
            mode: 'REPRICE',
            repricePreviewHash: PREVIEW_HASH,
          }),
          META,
        ),
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.message).toBe(QUOTE_CHANGED_MESSAGE);
      expect(ctx.repo.repricings).toHaveLength(0);
      expect(ctx.repo.inserted).toHaveLength(0);
      expect(ctx.repo.sources.get('plan-1')!.plan.quoteValidUntil).toBe(
        '2026-10-01',
      );
    });
  });
});
