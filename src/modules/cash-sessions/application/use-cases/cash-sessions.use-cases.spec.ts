import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TenantContextService } from '../../../../shared/tenancy/tenant-context.service';
import type {
  CashSessionRecord,
  CashSessionRepository,
  CloseContext,
  ClosingDraft,
} from '../../domain/ports/cash-session-repository.port';
import type { CashActor } from '../../domain/cash-session.entity';
import {
  AddCashAdjustmentUseCase,
  ALREADY_OPEN_MESSAGE,
  CloseCashSessionUseCase,
  DIFFERENCE_REASON_REQUIRED_MESSAGE,
  GetCashSessionUseCase,
  ListCashSessionsUseCase,
  NOT_CLOSED_MESSAGE,
  OpenCashSessionUseCase,
  ReopenCashSessionUseCase,
  SESSION_CLOSED_MESSAGE,
  UNKNOWN_LOCATION_MESSAGE,
} from './cash-sessions.use-cases';

const ADMIN: CashActor = { userId: 'u-admin', isAdmin: true };
const RECEPTION: CashActor = { userId: 'u-recep', isAdmin: false };
// 2026-10-17 21:00 en la zona de la sede = 2026-10-18 02:00 UTC.
const NOW = new Date('2026-10-18T02:00:00.000Z');

function record(extra: Partial<CashSessionRecord> = {}): CashSessionRecord {
  return {
    id: 's-1',
    status: 'OPEN',
    location: { id: 'loc-1', name: 'Sede' },
    openedBy: { id: RECEPTION.userId, fullName: 'Rita' },
    openedAt: NOW,
    openedOn: '2026-10-17',
    closedAt: null,
    closedBy: null,
    reopenCount: 0,
    floats: [{ currency: 'USD', amount: 50_000 }],
    differences: [],
    unjustifiedDifference: false,
    notes: null,
    timeZone: 'America/Caracas',
    regional: {
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    },
    expected: [
      {
        currency: 'USD',
        method: 'CASH',
        opening: 50_000,
        payments: 20_000,
        paymentsCount: 1,
        paymentAdjustments: 0,
        adjustments: 0,
        outflows: 0,
        outflowsCount: 0,
        expected: 70_000,
        amountHidden: false,
      },
    ],
    payments: [],
    voidedPayments: [],
    outflows: [],
    voidedOutflows: [],
    creditRefunds: [],
    adjustments: [],
    laterAdjustments: [],
    closing: null,
    closings: [],
    reopenings: [],
    openLaterGroups: [],
    ...extra,
  };
}

// Propiedades (no métodos): `expect(repo.x)` no separa un método de su objeto.
type FakeRepo = { [K in keyof CashSessionRepository]: jest.Mock };
const asRepo = (fake: FakeRepo) => fake as unknown as CashSessionRepository;

function fakeRepo(): FakeRepo {
  return {
    getSettings: jest
      .fn()
      .mockResolvedValue({ requireOpenSession: false, blindClose: false }),
    updateSettings: jest.fn((s: unknown) => Promise.resolve(s)),
    resolveLocation: jest.fn().mockResolvedValue('loc-1'),
    missingCurrencies: jest.fn().mockResolvedValue([]),
    open: jest.fn().mockResolvedValue({ id: 's-1' }),
    findOpenId: jest.fn().mockResolvedValue(null),
    list: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    detail: jest.fn().mockResolvedValue(record()),
    close: jest.fn().mockResolvedValue('CLOSED'),
    reopen: jest.fn().mockResolvedValue('REOPENED'),
    addCorrection: jest.fn().mockResolvedValue({ kind: 'NOT_CLOSED' }),
    countReceiptViews: jest.fn().mockResolvedValue({ receipts: 0, views: 0 }),
  };
}

const context = new TenantContextService();

describe('GetCashSessionUseCase (DX-027)', () => {
  it('RECEPTION solo ve las suyas (el repositorio filtra por quien abrió)', async () => {
    const repo = fakeRepo();
    repo.detail.mockResolvedValue(null);
    const get = new GetCashSessionUseCase(asRepo(repo), context);
    await expect(get.execute('s-1', RECEPTION)).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.detail).toHaveBeenCalledWith('s-1', {
      openedById: RECEPTION.userId,
    });
    await get.execute('s-1', ADMIN).catch(() => undefined);
    expect(repo.detail).toHaveBeenLastCalledWith('s-1', {});
  });

  it('DX-354: el detalle conserva la región de la sede de la caja, también con arqueo ciego', async () => {
    const repo = fakeRepo();
    repo.getSettings.mockResolvedValue({
      requireOpenSession: false,
      blindClose: true,
    });
    const get = new GetCashSessionUseCase(asRepo(repo), context);
    expect((await get.execute('s-1', RECEPTION)).regional).toEqual({
      timeZone: 'America/Caracas',
      locale: 'es-VE',
      hourCycle: 'h12',
    });
  });

  it('con arqueo ciego, quien cuenta no ve el esperado ni los abonos mientras está abierta; ADMIN sí', async () => {
    const repo = fakeRepo();
    repo.getSettings.mockResolvedValue({
      requireOpenSession: false,
      blindClose: true,
    });
    const get = new GetCashSessionUseCase(asRepo(repo), context);
    const blind = await get.execute('s-1', RECEPTION);
    expect(blind).toMatchObject({
      blindHidden: true,
      expected: null,
      payments: null,
    });
    expect(blind.can).toEqual({ close: true, reopen: false, adjust: false });
    const admin = await get.execute('s-1', ADMIN);
    expect(admin.blindHidden).toBe(false);
    expect(admin.expected).not.toBeNull();
    expect(admin.can).toEqual({ close: true, reopen: false, adjust: false });
  });

  // SEC-043: matriz arqueo ciego × rol × estado de la caja. Solo se oculta
  // con ciego, caja abierta y quien no es ADMIN.
  const voided = {
    id: 'p-2',
    paidAt: NOW,
    paidOn: '2026-10-17',
    amount: 5_000,
    currency: 'USD',
    method: 'CASH' as const,
    receiptNumber: null,
    patient: { id: 'pt-1', fullName: 'Ana' },
    createdBy: null,
    collectedAmount: 5_000,
    voidedAt: NOW,
    voidedBy: null,
    voidReason: 'Error',
    bookedAsAdjustment: false,
    amountHidden: false,
  };
  const adjustment = {
    id: 'a-1',
    kind: 'LATE_PAYMENT' as const,
    currency: 'USD',
    method: 'CASH' as const,
    amount: 3_000,
    reason: null,
    createdAt: NOW,
    createdBy: { id: 'u-x', fullName: null },
    sessionId: 's-1',
    // Cuenta en s-1; en la matriz solo se mira cuando s-1 está cerrada o
    // quien consulta no cuenta a ciegas.
    sessionStatus: 'CLOSED' as const,
    amountHidden: false,
    payment: null,
    expensePayment: null,
    originalSession: null,
  };
  const earlierClosing = {
    id: 'c-1',
    sequence: 1,
    closedAt: NOW,
    closedBy: { id: RECEPTION.userId, fullName: 'Rita' },
    blind: true,
    hasDifference: false,
    differenceReason: null,
    unjustifiedDifference: false,
    receiptViews: null,
    notes: null,
    suggestedLockDate: '2026-10-17',
    lines: [
      {
        currency: 'USD',
        method: 'CASH' as const,
        opening: 50_000,
        expected: 70_000,
        counted: 70_000,
        difference: 0,
        amountHidden: false,
      },
    ],
  };
  describe.each([
    { blindClose: true, status: 'OPEN' as const, hidden: [false, true] },
    { blindClose: true, status: 'CLOSED' as const, hidden: [false, false] },
    { blindClose: false, status: 'OPEN' as const, hidden: [false, false] },
    { blindClose: false, status: 'CLOSED' as const, hidden: [false, false] },
  ])(
    'ciego=$blindClose, caja $status (SEC-043)',
    ({ blindClose, status, hidden }) => {
      it.each([
        ['ADMIN', ADMIN, hidden[0]],
        ['RECEPTION', RECEPTION, hidden[1]],
      ])('%s: oculto=%s', async (_who, actor, isHidden) => {
        const repo = fakeRepo();
        repo.getSettings.mockResolvedValue({
          requireOpenSession: false,
          blindClose,
        });
        repo.detail.mockResolvedValue(
          record({
            status,
            reopenCount: 1,
            voidedPayments: [voided],
            adjustments: [adjustment],
            closing: earlierClosing,
            closings: [earlierClosing],
          }),
        );
        const view = await new GetCashSessionUseCase(
          asRepo(repo),
          context,
        ).execute('s-1', actor);
        expect(view.blindHidden).toBe(isHidden);
        if (isHidden) {
          expect(view).toMatchObject({
            expected: null,
            payments: null,
            voidedPayments: null,
            adjustments: null,
          });
          expect(view.closing?.lines).toEqual([]);
          expect(view.closings.map((c) => c.lines)).toEqual([[]]);
          // Lo que movió quien cuenta sigue a la vista.
          expect(view.floats).toEqual([{ currency: 'USD', amount: 50_000 }]);
        } else {
          expect(view.expected).not.toBeNull();
          expect(view.voidedPayments).toEqual([voided]);
          expect(view.adjustments).toEqual([adjustment]);
          expect(view.closings[0].lines).toHaveLength(1);
        }
      });
    },
  );

  // SEC-043 (revisión M1): una caja A ya cerrada no deja ver el importe de lo
  // que, nacido de ella, cuenta en otra caja abierta o está pendiente.
  describe('caja cerrada con ajustes posteriores en otra caja (SEC-043, M1)', () => {
    const voidOf = (
      sessionId: string | null,
      status: 'OPEN' | 'CLOSED' | null,
    ) => ({
      ...adjustment,
      id: `adj-${status ?? 'pending'}`,
      kind: 'VOID' as const,
      amount: -40,
      sessionId,
      sessionStatus: status,
      payment: {
        id: `p-${status ?? 'pending'}`,
        patient: { id: 'pt-1', fullName: 'Ana' },
        paidOn: '2026-10-17',
        receiptNumber: null,
      },
      originalSession: {
        id: 's-1',
        openedAt: NOW,
        openedBy: { id: RECEPTION.userId, fullName: 'Rita' },
      },
    });
    const voidedFor = (id: string) => ({
      ...voided,
      id,
      amount: 40,
      collectedAmount: 40,
      bookedAsAdjustment: true,
    });
    const closedA = () =>
      record({
        status: 'CLOSED',
        // Lo que cuenta en A (cerrada) se ve siempre.
        adjustments: [{ ...adjustment, sessionStatus: 'CLOSED' as const }],
        laterAdjustments: [
          voidOf('s-b', 'OPEN'),
          voidOf(null, null),
          voidOf('s-c', 'CLOSED'),
        ],
        voidedPayments: [
          voidedFor('p-OPEN'),
          voidedFor('p-pending'),
          voidedFor('p-CLOSED'),
        ],
        // Ronda 4: el grupo USD·CASH tiene ajustes posteriores abiertos o
        // pendientes; VES·CASH no.
        openLaterGroups: [
          { currency: 'USD', method: 'CASH' },
          { currency: 'USD', method: 'CASH' },
        ],
        expected: [
          { ...record().expected![0] },
          {
            ...record().expected![0],
            currency: 'VES',
            opening: 0,
            payments: 1_000,
            expected: 1_000,
          },
        ],
        differences: [
          { currency: 'USD', amount: 0, amountHidden: false },
          { currency: 'VES', amount: -10, amountHidden: false },
        ],
        closing: earlierClosingWith(),
        closings: [earlierClosingWith()],
      });
    const earlierClosingWithLines = [
      {
        currency: 'USD',
        method: 'CASH' as const,
        opening: 50_000,
        expected: 70_000,
        counted: 70_000,
        difference: 0,
        amountHidden: false,
      },
      {
        currency: 'VES',
        method: 'CASH' as const,
        opening: 0,
        expected: 1_000,
        counted: 990,
        difference: -10,
        amountHidden: false,
      },
    ];
    function earlierClosingWith() {
      return { ...earlierClosing, lines: earlierClosingWithLines };
    }

    it.each([
      ['RECEPTION con ciego', RECEPTION, true, true],
      ['ADMIN con ciego', ADMIN, true, false],
      ['RECEPTION sin ciego', RECEPTION, false, false],
    ])(
      '%s: oculto=%s en lo abierto o pendiente',
      async (_who, actor, blindClose, hides) => {
        const repo = fakeRepo();
        repo.getSettings.mockResolvedValue({
          requireOpenSession: false,
          blindClose,
        });
        repo.detail.mockResolvedValue(closedA());
        const view = await new GetCashSessionUseCase(
          asRepo(repo),
          context,
        ).execute('s-1', actor);
        const later = Object.fromEntries(
          view.laterAdjustments.map((a) => [a.id, a]),
        );
        const voidedById = Object.fromEntries(
          (view.voidedPayments ?? []).map((p) => [p.id, p]),
        );
        for (const key of ['OPEN', 'pending']) {
          expect(later[`adj-${key}`]).toMatchObject(
            hides
              ? { amount: null, amountHidden: true }
              : { amount: -40, amountHidden: false },
          );
          expect(voidedById[`p-${key}`]).toMatchObject(
            hides
              ? { amount: null, collectedAmount: null, amountHidden: true }
              : { amount: 40, amountHidden: false },
          );
        }
        // Lo que cuenta en una caja ya cerrada, y lo de esta, nunca se oculta.
        expect(later['adj-CLOSED']).toMatchObject({
          amount: -40,
          amountHidden: false,
        });
        expect(voidedById['p-CLOSED']).toMatchObject({
          amount: 40,
          amountHidden: false,
        });
        // El grupo afectado (USD·CASH) va sin esperado, desglose, recuentos ni
        // diferencia; lo contado y el fondo se quedan. VES·CASH, intacto.
        const usd = view.expected?.find((l) => l.currency === 'USD');
        const ves = view.expected?.find((l) => l.currency === 'VES');
        expect(usd).toMatchObject(
          hides
            ? {
                opening: 50_000,
                payments: null,
                paymentsCount: null,
                paymentAdjustments: null,
                adjustments: null,
                outflows: null,
                outflowsCount: null,
                expected: null,
                amountHidden: true,
              }
            : { payments: 20_000, expected: 70_000, amountHidden: false },
        );
        expect(ves).toMatchObject({ expected: 1_000, amountHidden: false });
        for (const closing of [view.closing, ...view.closings]) {
          const [usdLine, vesLine] = closing!.lines;
          expect(usdLine).toMatchObject(
            hides
              ? {
                  expected: null,
                  difference: null,
                  counted: 70_000,
                  amountHidden: true,
                }
              : { expected: 70_000, difference: 0, amountHidden: false },
          );
          expect(vesLine).toMatchObject({
            expected: 1_000,
            difference: -10,
            amountHidden: false,
          });
        }
        expect(view.differences).toEqual([
          hides
            ? { currency: 'USD', amount: null, amountHidden: true }
            : { currency: 'USD', amount: 0, amountHidden: false },
          { currency: 'VES', amount: -10, amountHidden: false },
        ]);
        // El dato interno no sale en la respuesta.
        expect(view).not.toHaveProperty('openLaterGroups');
        expect(view.adjustments?.[0]).toMatchObject({
          amount: 3_000,
          amountHidden: false,
        });
      },
    );
  });

  // SEC-043-bis: recibos consultados antes de cerrar a ciegas, solo para ADMIN.
  describe('recibos consultados por quien cerró a ciegas (SEC-043-bis)', () => {
    const closedAt = new Date('2026-10-18T01:00:00.000Z');
    const closingOf = (blind: boolean, id = 'c-1') => ({
      ...earlierClosing,
      id,
      blind,
      closedAt,
    });

    it('ADMIN: cada cierre a ciegas lleva los recibos que abrió quien cerró, entre la apertura y ese cierre', async () => {
      const repo = fakeRepo();
      repo.countReceiptViews.mockResolvedValue({ receipts: 3, views: 5 });
      const blind = closingOf(true);
      repo.detail.mockResolvedValue(
        record({ status: 'CLOSED', closing: blind, closings: [blind] }),
      );
      const view = await new GetCashSessionUseCase(
        asRepo(repo),
        context,
      ).execute('s-1', ADMIN);
      expect(repo.countReceiptViews).toHaveBeenCalledWith({
        sessionId: 's-1',
        actorUserId: RECEPTION.userId,
        from: NOW,
        to: closedAt,
      });
      expect(view.closing?.receiptViews).toEqual({ receipts: 3, views: 5 });
      expect(view.closings[0].receiptViews).toEqual({ receipts: 3, views: 5 });
    });

    it('un cierre con el esperado a la vista no la lleva (no hay nada que reconstruir)', async () => {
      const repo = fakeRepo();
      const plain = closingOf(false);
      repo.detail.mockResolvedValue(
        record({ status: 'CLOSED', closing: plain, closings: [plain] }),
      );
      const view = await new GetCashSessionUseCase(
        asRepo(repo),
        context,
      ).execute('s-1', ADMIN);
      expect(repo.countReceiptViews).not.toHaveBeenCalled();
      expect(view.closing?.receiptViews).toBeNull();
    });

    it('RECEPTION nunca la recibe ni se calcula', async () => {
      const repo = fakeRepo();
      repo.getSettings.mockResolvedValue({
        requireOpenSession: false,
        blindClose: true,
      });
      const blind = closingOf(true);
      repo.detail.mockResolvedValue(
        record({ status: 'CLOSED', closing: blind, closings: [blind] }),
      );
      const view = await new GetCashSessionUseCase(
        asRepo(repo),
        context,
      ).execute('s-1', RECEPTION);
      expect(repo.countReceiptViews).not.toHaveBeenCalled();
      expect(view.closing?.receiptViews).toBeNull();
    });
  });

  it('cerrada: se ve el arqueo aunque sea ciego, y solo ADMIN reabre o corrige', async () => {
    const repo = fakeRepo();
    repo.getSettings.mockResolvedValue({
      requireOpenSession: false,
      blindClose: true,
    });
    repo.detail.mockResolvedValue(record({ status: 'CLOSED' }));
    const get = new GetCashSessionUseCase(asRepo(repo), context);
    const reception = await get.execute('s-1', RECEPTION);
    expect(reception.blindHidden).toBe(false);
    expect(reception.can).toEqual({
      close: false,
      reopen: false,
      adjust: false,
    });
    expect((await get.execute('s-1', ADMIN)).can).toEqual({
      close: false,
      reopen: true,
      adjust: true,
    });
  });
});

describe('OpenCashSessionUseCase (DX-027)', () => {
  function build(repo = fakeRepo()) {
    return {
      repo,
      open: new OpenCashSessionUseCase(
        asRepo(repo),
        new GetCashSessionUseCase(asRepo(repo), context),
        context,
      ),
    };
  }

  it('abre con el fondo en céntimos y quien abre del token', async () => {
    const { repo, open } = build();
    await open.execute(
      { floats: [{ currency: 'usd', amount: 50_000.5 }], notes: '  Turno  ' },
      RECEPTION,
    );
    expect(repo.open).toHaveBeenCalledWith({
      locationId: 'loc-1',
      openedById: RECEPTION.userId,
      floats: [{ currency: 'USD', cents: 5_000_050 }],
      notes: 'Turno',
    });
  });

  it('importes grandes con 2 decimales exactos no son 400 (el error del coma flotante no cuenta como decimal)', async () => {
    const { repo, open } = build();
    // 555.555.555,55 × 100 = 55.555.555.554,999… en coma flotante.
    await open.execute(
      { floats: [{ currency: 'USD', amount: 555_555_555.55 }] },
      RECEPTION,
    );
    expect(repo.open).toHaveBeenCalledWith(
      expect.objectContaining({
        floats: [{ currency: 'USD', cents: 55_555_555_555 }],
      }),
    );
  });

  it('otra caja abierta del mismo usuario en la sede: 409', async () => {
    const { repo, open } = build();
    repo.open.mockResolvedValue('ALREADY_OPEN');
    await expect(open.execute({ floats: [] }, RECEPTION)).rejects.toThrow(
      new ConflictException(ALREADY_OPEN_MESSAGE),
    );
  });

  it('sede ajena, moneda desconocida, moneda repetida o importe con más de 2 decimales: 400', async () => {
    const { repo, open } = build();
    repo.resolveLocation.mockResolvedValueOnce(null);
    await expect(
      open.execute({ floats: [], locationId: 'loc-x' }, RECEPTION),
    ).rejects.toThrow(new BadRequestException(UNKNOWN_LOCATION_MESSAGE));
    repo.missingCurrencies.mockResolvedValueOnce(['XXX']);
    await expect(
      open.execute({ floats: [{ currency: 'XXX', amount: 1 }] }, RECEPTION),
    ).rejects.toThrow(BadRequestException);
    await expect(
      open.execute(
        {
          floats: [
            { currency: 'USD', amount: 1 },
            { currency: 'usd', amount: 2 },
          ],
        },
        RECEPTION,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      open.execute({ floats: [{ currency: 'USD', amount: 1.005 }] }, RECEPTION),
    ).rejects.toThrow(BadRequestException);
    expect(repo.open).not.toHaveBeenCalled();
  });
});

describe('CloseCashSessionUseCase (DX-027)', () => {
  const ctx: CloseContext = {
    locationId: 'loc-1',
    openedById: RECEPTION.userId,
    timeZone: 'America/Caracas',
    blind: true,
    expected: [
      {
        currency: 'USD',
        method: 'CASH',
        openingCents: 5_000_000,
        paymentsCents: 2_000_000,
        paymentsCount: 1,
        paymentAdjustmentsCents: 0,
        adjustmentsCents: 0,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 7_000_000,
      },
    ],
  };

  function build(repo = fakeRepo(), closeCtx: CloseContext = ctx) {
    let draft: ClosingDraft | undefined;
    repo.close.mockImplementation(
      (
        _id: string,
        _scope: unknown,
        _by: string,
        decide: (c: CloseContext) => ClosingDraft,
      ) => {
        draft = decide(closeCtx);
        return Promise.resolve('CLOSED');
      },
    );
    const close = new CloseCashSessionUseCase(
      asRepo(repo),
      new GetCashSessionUseCase(asRepo(repo), context),
      () => NOW,
      context,
    );
    return { repo, close, draft: () => draft };
  }

  it('cuadrado con el esperado a la vista: guarda contado y diferencia 0, sin motivo, con la fecha de bloqueo del día de la sede', async () => {
    const { close, draft } = build(fakeRepo(), { ...ctx, blind: false });
    await close.execute(
      's-1',
      {
        counts: [{ currency: 'USD', method: 'CASH', counted: 70_000 }],
        differenceReason: 'No hace falta',
      },
      RECEPTION,
    );
    expect(draft()).toMatchObject({
      hasDifference: false,
      differenceReason: null,
      blind: false,
      suggestedLockDate: '2026-10-17',
      lines: [
        expect.objectContaining({
          countedCents: 7_000_000,
          differenceCents: 0,
        }),
      ],
    });
  });

  // SEC-043: matriz arqueo ciego × rol × (cuadra / no cuadra) sin motivo. A
  // ciegas y sin ser ADMIN, el cierre no responde distinto si cuadra: se
  // guarda siempre, y si no cuadra queda «diferencia sin justificar».
  describe.each([
    {
      blind: true,
      actor: RECEPTION,
      who: 'RECEPTION',
      differs: { outcome: 'saved', unjustified: true },
    },
    {
      blind: true,
      actor: ADMIN,
      who: 'ADMIN',
      differs: { outcome: '400', unjustified: false },
    },
    {
      blind: false,
      actor: RECEPTION,
      who: 'RECEPTION',
      differs: { outcome: '400', unjustified: false },
    },
    {
      blind: false,
      actor: ADMIN,
      who: 'ADMIN',
      differs: { outcome: '400', unjustified: false },
    },
  ])(
    'ciego=$blind, $who, sin motivo (SEC-043)',
    ({ blind, actor, differs }) => {
      const closeCtx = { ...ctx, blind };

      it('si cuadra: cierra sin marca', async () => {
        const { close, draft } = build(fakeRepo(), closeCtx);
        await close.execute(
          's-1',
          { counts: [{ currency: 'USD', method: 'CASH', counted: 70_000 }] },
          actor,
        );
        expect(draft()).toMatchObject({
          hasDifference: false,
          differenceReason: null,
          unjustifiedDifference: false,
          blind,
        });
      });

      it(`si no cuadra: ${differs.outcome === 'saved' ? 'cierra igual y queda «diferencia sin justificar»' : '400 que pide el motivo'}`, async () => {
        const { repo, close, draft } = build(fakeRepo(), closeCtx);
        const attempt = close.execute(
          's-1',
          { counts: [{ currency: 'USD', method: 'CASH', counted: 69_000 }] },
          actor,
        );
        if (differs.outcome === '400') {
          await expect(attempt).rejects.toThrow(
            new BadRequestException(DIFFERENCE_REASON_REQUIRED_MESSAGE),
          );
          return;
        }
        await expect(attempt).resolves.toBeDefined();
        expect(repo.close).toHaveBeenCalledTimes(1);
        expect(draft()).toMatchObject({
          hasDifference: true,
          differenceReason: null,
          unjustifiedDifference: differs.unjustified,
          blind: true,
        });
      });
    },
  );

  it('a ciegas, RECEPTION recibe lo mismo (un cierre guardado) cuadre o no: no hay oráculo (SEC-043)', async () => {
    const outcomes: unknown[] = [];
    for (const counted of [70_000, 69_000, 71_000]) {
      const { close } = build();
      outcomes.push(
        await close
          .execute(
            's-1',
            { counts: [{ currency: 'USD', method: 'CASH', counted }] },
            RECEPTION,
          )
          .then(
            () => 'CLOSED',
            (error: unknown) => error,
          ),
      );
    }
    expect(outcomes).toEqual(['CLOSED', 'CLOSED', 'CLOSED']);
  });

  it('a ciegas y cuadrado, RECEPTION: el motivo que escribió no se pierde (SEC-043, B4); ADMIN, como siempre', async () => {
    for (const [actor, kept] of [
      [RECEPTION, 'Creo que faltó el cambio de una consulta'],
      [ADMIN, null],
    ] as const) {
      const { close, draft } = build();
      await close.execute(
        's-1',
        {
          counts: [{ currency: 'USD', method: 'CASH', counted: 70_000 }],
          differenceReason: 'Creo que faltó el cambio de una consulta',
        },
        actor,
      );
      expect(draft()).toMatchObject({
        hasDifference: false,
        differenceReason: kept,
        unjustifiedDifference: false,
      });
    }
  });

  it('a ciegas con diferencia y motivo: guarda el motivo sin marca', async () => {
    const { close, draft } = build();
    await close.execute(
      's-1',
      {
        counts: [{ currency: 'USD', method: 'CASH', counted: 69_000 }],
        differenceReason: 'Faltó cambio',
      },
      RECEPTION,
    );
    expect(draft()).toMatchObject({
      hasDifference: true,
      differenceReason: 'Faltó cambio',
      unjustifiedDifference: false,
    });
  });

  it('con diferencia y motivo: la guarda', async () => {
    const { close, draft } = build();
    await close.execute(
      's-1',
      {
        counts: [{ currency: 'USD', method: 'CASH', counted: 69_000 }],
        differenceReason: 'Faltó cambio',
      },
      RECEPTION,
    );
    expect(draft()).toMatchObject({
      hasDifference: true,
      differenceReason: 'Faltó cambio',
    });
  });

  it('RECEPTION solo cierra las suyas; una caja ya cerrada es 409', async () => {
    const { repo, close } = build();
    repo.close.mockResolvedValueOnce('NOT_FOUND');
    await expect(
      close.execute('s-1', { counts: [] }, RECEPTION),
    ).rejects.toThrow(NotFoundException);
    expect(repo.close).toHaveBeenLastCalledWith(
      's-1',
      { openedById: RECEPTION.userId },
      RECEPTION.userId,
      expect.any(Function),
    );
    repo.close.mockResolvedValueOnce('NOT_OPEN');
    await expect(close.execute('s-1', { counts: [] }, ADMIN)).rejects.toThrow(
      new ConflictException(SESSION_CLOSED_MESSAGE),
    );
    expect(repo.close).toHaveBeenLastCalledWith(
      's-1',
      {},
      ADMIN.userId,
      expect.any(Function),
    );
  });

  it('un par contado dos veces: 400', async () => {
    const { close } = build();
    await expect(
      close.execute(
        's-1',
        {
          counts: [
            { currency: 'USD', method: 'CASH', counted: 1 },
            { currency: 'USD', method: 'CASH', counted: 2 },
          ],
        },
        RECEPTION,
      ),
    ).rejects.toThrow(BadRequestException);
  });
});

describe('ReopenCashSessionUseCase y AddCashAdjustmentUseCase (DX-027)', () => {
  it('reabrir: 404, 409 si no está cerrada o si quien la abrió ya tiene otra abierta', async () => {
    const repo = fakeRepo();
    const reopen = new ReopenCashSessionUseCase(
      asRepo(repo),
      new GetCashSessionUseCase(asRepo(repo), context),
    );
    repo.reopen.mockResolvedValueOnce('NOT_FOUND');
    await expect(reopen.execute('s-1', 'Motivo', ADMIN)).rejects.toThrow(
      NotFoundException,
    );
    repo.reopen.mockResolvedValueOnce('NOT_CLOSED');
    await expect(reopen.execute('s-1', 'Motivo', ADMIN)).rejects.toThrow(
      new ConflictException(NOT_CLOSED_MESSAGE),
    );
    repo.reopen.mockResolvedValueOnce('ALREADY_OPEN');
    await expect(reopen.execute('s-1', 'Motivo', ADMIN)).rejects.toThrow(
      ConflictException,
    );
    await reopen.execute('s-1', '  Faltó un abono ', ADMIN);
    expect(repo.reopen).toHaveBeenLastCalledWith(
      's-1',
      ADMIN.userId,
      'Faltó un abono',
    );
  });

  it('corregir: importe distinto de 0 con 2 decimales, moneda del catálogo y caja cerrada', async () => {
    const repo = fakeRepo();
    const adjust = new AddCashAdjustmentUseCase(asRepo(repo));
    const input = {
      currency: 'USD',
      method: 'CASH' as const,
      amount: -5_000,
      reason: 'Billete falso',
    };
    await expect(
      adjust.execute('s-1', { ...input, amount: 0 }, ADMIN),
    ).rejects.toThrow(BadRequestException);
    await expect(adjust.execute('s-1', input, ADMIN)).rejects.toThrow(
      ConflictException,
    );
    repo.addCorrection.mockResolvedValueOnce({ kind: 'NOT_FOUND' });
    await expect(adjust.execute('s-1', input, ADMIN)).rejects.toThrow(
      NotFoundException,
    );
    expect(repo.addCorrection).toHaveBeenLastCalledWith('s-1', {
      currency: 'USD',
      method: 'CASH',
      cents: -500_000,
      reason: 'Billete falso',
      createdById: ADMIN.userId,
    });
  });
});

describe('ListCashSessionsUseCase (DX-027)', () => {
  it('RECEPTION solo lista las suyas; ADMIN todas; período válido', async () => {
    const repo = fakeRepo();
    const list = new ListCashSessionsUseCase(asRepo(repo), context);
    await list.execute({ from: '2026-10-01', to: '2026-10-17' }, RECEPTION);
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ openedById: RECEPTION.userId, skip: 0 }),
    );
    await list.execute({ page: 2, pageSize: 10 }, ADMIN);
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ openedById: expect.anything() as unknown }),
    );
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ skip: 10, take: 10 }),
    );
    await expect(
      list.execute({ from: '2026-10-17', to: '2026-10-01' }, ADMIN),
    ).rejects.toThrow(BadRequestException);
  });

  it.each([
    ['RECEPTION con ciego', RECEPTION, true, true],
    ['ADMIN con ciego', ADMIN, true, false],
    ['RECEPTION sin ciego', RECEPTION, false, false],
  ])(
    'SEC-043 (ronda 4) %s: la diferencia de una moneda con anulación posterior abierta, oculta=%s; sin el dato interno',
    async (_who, actor, blindClose, hides) => {
      const repo = fakeRepo();
      repo.getSettings.mockResolvedValue({
        requireOpenSession: false,
        blindClose,
      });
      const { expected: _e, ...summary } = record({ status: 'CLOSED' });
      repo.list.mockResolvedValue({
        items: [
          {
            ...summary,
            differences: [
              { currency: 'USD', amount: 0, amountHidden: false },
              { currency: 'VES', amount: -10, amountHidden: false },
            ],
            openLaterGroups: [{ currency: 'USD', method: 'CASH' }],
          },
        ],
        total: 1,
      });
      const page = await new ListCashSessionsUseCase(
        asRepo(repo),
        context,
      ).execute({}, actor);
      expect(page.items[0].differences).toEqual([
        hides
          ? { currency: 'USD', amount: null, amountHidden: true }
          : { currency: 'USD', amount: 0, amountHidden: false },
        { currency: 'VES', amount: -10, amountHidden: false },
      ]);
      expect(page.items[0]).not.toHaveProperty('openLaterGroups');
    },
  );
});

// DX-089: personal restringido a sedes.
describe('cajas y sedes permitidas (DX-089)', () => {
  const asRestricted = <T>(fn: () => Promise<T>) =>
    context.run('t1', undefined, fn, ['loc-1', 'loc-2']);

  it('el listado sin sede va acotado a las permitidas; una sede ajena es 403', async () => {
    const repo = fakeRepo();
    const list = new ListCashSessionsUseCase(asRepo(repo), context);
    await asRestricted(() => list.execute({}, RECEPTION));
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ locationIds: ['loc-1', 'loc-2'] }),
    );
    await list.execute({}, ADMIN);
    expect(repo.list).toHaveBeenLastCalledWith(
      expect.objectContaining({ locationIds: undefined }),
    );
    await expect(
      asRestricted(() => list.execute({ locationId: 'loc-9' }, RECEPTION)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('una caja de una sede no permitida es 403 al verla y al cerrarla', async () => {
    const repo = fakeRepo();
    repo.detail.mockResolvedValue(
      record({ location: { id: 'loc-9', name: 'Otra' } }),
    );
    const get = new GetCashSessionUseCase(asRepo(repo), context);
    await expect(
      asRestricted(() => get.execute('s-1', RECEPTION)),
    ).rejects.toThrow(ForbiddenException);

    repo.close.mockImplementation(
      (
        _id: string,
        _scope: unknown,
        _by: string,
        decide: (ctx: CloseContext) => ClosingDraft,
      ) => {
        decide({
          locationId: 'loc-9',
          expected: [],
          blind: false,
          timeZone: 'America/Caracas',
        } as unknown as CloseContext);
        return Promise.resolve('CLOSED');
      },
    );
    const close = new CloseCashSessionUseCase(
      asRepo(repo),
      get,
      () => NOW,
      context,
    );
    await expect(
      asRestricted(() => close.execute('s-1', { counts: [] }, RECEPTION)),
    ).rejects.toThrow(ForbiddenException);
  });

  it('abrir en una sede ajena es 403', async () => {
    const repo = fakeRepo();
    const open = new OpenCashSessionUseCase(
      asRepo(repo),
      new GetCashSessionUseCase(asRepo(repo), context),
      context,
    );
    await expect(
      asRestricted(() =>
        open.execute({ floats: [], locationId: 'loc-9' }, RECEPTION),
      ),
    ).rejects.toThrow(ForbiddenException);
    expect(repo.resolveLocation).not.toHaveBeenCalled();
  });
});
