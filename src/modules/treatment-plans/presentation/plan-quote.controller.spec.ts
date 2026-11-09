import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ClinicRole, TreatmentPlanStatus } from '@prisma/client';
import type { Request } from 'express';
import type {
  PartialAcceptancePreview,
  PlanQuoteAcceptanceView,
  PlanQuoteDocument,
  PreviewPartialAcceptanceUseCase,
} from '../application/use-cases/plan-quote.use-cases';
import {
  PlanQuoteController,
  acceptanceAuditMetadata,
} from './plan-quote.controller';
import {
  AcceptTreatmentPlanDto,
  PartialAcceptancePreviewRequestDto,
} from './dto/plan-quote.dto';

// DX-417: la ruta de la vista previa parcial, el cuerpo de la firma con
// `partial` y lo que la firma deja en la auditoría.

const ITEM = '11111111-1111-4111-8111-111111111111';
const PENDING = '22222222-2222-4222-8222-222222222222';
const REPRICING = '33333333-3333-4333-8333-333333333333';

function acceptance(
  overrides: Partial<PlanQuoteAcceptanceView> = {},
): PlanQuoteAcceptanceView {
  return {
    signerName: 'Ana Pérez',
    signature: 'iVBORw0KGgo=',
    acceptedAt: new Date('2026-10-16T14:00:00.000Z'),
    acceptedByName: 'Dra. Gómez',
    acceptanceHash: 'a'.repeat(64),
    integrityOk: true,
    remote: null,
    ipAddress: null,
    userAgent: null,
    quoteValidUntil: '2026-10-20',
    expiredMode: null,
    expiredReason: null,
    expiredNote: null,
    repricingId: null,
    pendingPlanId: null,
    pendingItemIds: null,
    pendingTotal: null,
    ...overrides,
  };
}

const doc = (a: PlanQuoteAcceptanceView | null) =>
  ({ acceptance: a }) as unknown as PlanQuoteDocument;

describe('acceptanceAuditMetadata (DX-379 C, DX-417)', () => {
  it('aceptado entero y sin vencer: nada que añadir', () => {
    expect(acceptanceAuditMetadata(doc(acceptance()))).toBeUndefined();
    expect(acceptanceAuditMetadata(doc(null))).toBeUndefined();
  });

  it('en parte: PLAN_PARTIALLY_ACCEPTED y el pendiente, sin importes', () => {
    expect(
      acceptanceAuditMetadata(
        doc(
          acceptance({
            pendingPlanId: PENDING,
            pendingItemIds: [ITEM],
            pendingTotal: 180000,
          }),
        ),
      ),
    ).toEqual({
      reason: 'PLAN_PARTIALLY_ACCEPTED',
      params: { pendingPlanId: PENDING },
    });
  });

  it('en parte y vencido: manda el motivo del vencido y van los dos ids', () => {
    expect(
      acceptanceAuditMetadata(
        doc(
          acceptance({
            expiredMode: 'REPRICE',
            repricingId: REPRICING,
            pendingPlanId: PENDING,
            pendingItemIds: [ITEM],
            pendingTotal: 10,
          }),
        ),
      ),
    ).toEqual({
      reason: 'QUOTE_EXPIRED_REPRICED',
      params: { repricingId: REPRICING, pendingPlanId: PENDING },
    });
    expect(
      acceptanceAuditMetadata(
        doc(acceptance({ expiredMode: 'ORIGINAL_PRICES' })),
      ),
    ).toEqual({ reason: 'QUOTE_EXPIRED_ORIGINAL_PRICES' });
  });
});

describe('PlanQuoteController: vista previa parcial (DX-417)', () => {
  it('pasa la selección y el actor, y devuelve la firma como data URL', async () => {
    const calls: unknown[] = [];
    const preview: PartialAcceptancePreview = {
      accepted: {
        planStatus: TreatmentPlanStatus.PRESENTED,
        acceptance: null,
      } as unknown as PlanQuoteDocument,
      pending: { items: [], totals: [] },
      original: { totals: [] },
      repricing: null,
    };
    const useCase = {
      execute: (...args: unknown[]) => {
        calls.push(args);
        return Promise.resolve(preview);
      },
    } as unknown as PreviewPartialAcceptanceUseCase;
    const controller = new PlanQuoteController(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      useCase,
    );
    const req = {
      user: {
        sub: 'user-1',
        tenantId: 't-1',
        role: ClinicRole.DENTIST,
      },
    } as unknown as Request & { user: never };
    const out = await controller.partialAcceptancePreview(
      'patient-1',
      'plan-1',
      Object.assign(new PartialAcceptancePreviewRequestDto(), {
        itemIds: [ITEM],
        reprice: true,
      }),
      req,
    );
    expect(calls).toEqual([
      [
        'patient-1',
        'plan-1',
        { itemIds: [ITEM], reprice: true },
        { userId: 'user-1', role: ClinicRole.DENTIST },
      ],
    ]);
    expect(out).toEqual({ ...preview, repricing: null });
  });
});

describe('DTO de la aceptación parcial', () => {
  const errorsOf = async (cls: new () => object, body: object) =>
    (await validate(plainToInstance(cls, body))).flatMap((e) => [
      ...Object.values(e.constraints ?? {}),
      ...e.children!.flatMap((c) => Object.values(c.constraints ?? {})),
    ]);

  it('la vista previa exige de 1 a 100 UUID', async () => {
    expect(
      await errorsOf(PartialAcceptancePreviewRequestDto, { itemIds: [ITEM] }),
    ).toEqual([]);
    expect(
      await errorsOf(PartialAcceptancePreviewRequestDto, { itemIds: [] }),
    ).toEqual(['Elige al menos un procedimiento para aceptar.']);
    expect(
      await errorsOf(PartialAcceptancePreviewRequestDto, {
        itemIds: ['no-uuid'],
      }),
    ).toEqual(['Cada procedimiento debe ser un UUID.']);
    expect(
      await errorsOf(PartialAcceptancePreviewRequestDto, {
        itemIds: Array.from({ length: 101 }, () => ITEM),
      }),
    ).toEqual(['Elige como mucho 100 procedimientos.']);
    expect(
      await errorsOf(PartialAcceptancePreviewRequestDto, {
        itemIds: [ITEM],
        reprice: 'sí',
      }),
    ).toEqual(['reprice debe ser true o false.']);
  });

  it('la firma valida `partial` anidado', async () => {
    const base = {
      signerName: 'Ana Pérez',
      signature: 'iVBORw0KGgo=',
      contentHash: 'a'.repeat(64),
    };
    expect(
      await errorsOf(AcceptTreatmentPlanDto, {
        ...base,
        partial: { itemIds: [ITEM] },
      }),
    ).toEqual([]);
    expect(
      await errorsOf(AcceptTreatmentPlanDto, {
        ...base,
        partial: { itemIds: [] },
      }),
    ).toEqual(['Elige al menos un procedimiento para aceptar.']);
  });

  it('M-1: `partial` como lista (vacía o con objetos) no pasa: 400, nunca aceptación entera', async () => {
    const base = {
      signerName: 'Ana Pérez',
      signature: 'iVBORw0KGgo=',
      contentHash: 'a'.repeat(64),
    };
    for (const partial of [[], [{ itemIds: [ITEM] }], [{}], 'x']) {
      const errors = await validate(
        plainToInstance(AcceptTreatmentPlanDto, { ...base, partial }),
      );
      expect(errors.map((e) => e.property)).toEqual(['partial']);
      expect(Object.values(errors[0].constraints ?? {})).toContain(
        'partial debe ser un objeto con los procedimientos que se aceptan (itemIds).',
      );
    }
  });
});
