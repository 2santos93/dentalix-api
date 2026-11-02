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
    floats: [{ currency: 'COP', amount: 50_000 }],
    differences: [],
    notes: null,
    timeZone: 'America/Bogota',
    expected: [
      {
        currency: 'COP',
        method: 'CASH',
        opening: 50_000,
        payments: 20_000,
        paymentsCount: 1,
        adjustments: 0,
        outflows: 0,
        outflowsCount: 0,
        expected: 70_000,
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
      { floats: [{ currency: 'cop', amount: 50_000.5 }], notes: '  Turno  ' },
      RECEPTION,
    );
    expect(repo.open).toHaveBeenCalledWith({
      locationId: 'loc-1',
      openedById: RECEPTION.userId,
      floats: [{ currency: 'COP', cents: 5_000_050 }],
      notes: 'Turno',
    });
  });

  it('importes grandes con 2 decimales exactos no son 400 (el error del coma flotante no cuenta como decimal)', async () => {
    const { repo, open } = build();
    // 555.555.555,55 × 100 = 55.555.555.554,999… en coma flotante.
    await open.execute(
      { floats: [{ currency: 'COP', amount: 555_555_555.55 }] },
      RECEPTION,
    );
    expect(repo.open).toHaveBeenCalledWith(
      expect.objectContaining({
        floats: [{ currency: 'COP', cents: 55_555_555_555 }],
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
            { currency: 'COP', amount: 1 },
            { currency: 'cop', amount: 2 },
          ],
        },
        RECEPTION,
      ),
    ).rejects.toThrow(BadRequestException);
    await expect(
      open.execute({ floats: [{ currency: 'COP', amount: 1.005 }] }, RECEPTION),
    ).rejects.toThrow(BadRequestException);
    expect(repo.open).not.toHaveBeenCalled();
  });
});

describe('CloseCashSessionUseCase (DX-027)', () => {
  const ctx: CloseContext = {
    locationId: 'loc-1',
    openedById: RECEPTION.userId,
    timeZone: 'America/Bogota',
    blind: true,
    expected: [
      {
        currency: 'COP',
        method: 'CASH',
        openingCents: 5_000_000,
        paymentsCents: 2_000_000,
        paymentsCount: 1,
        adjustmentsCents: 0,
        outflowsCents: 0,
        outflowsCount: 0,
        expectedCents: 7_000_000,
      },
    ],
  };

  function build(repo = fakeRepo()) {
    let draft: ClosingDraft | undefined;
    repo.close.mockImplementation(
      (
        _id: string,
        _scope: unknown,
        _by: string,
        decide: (c: CloseContext) => ClosingDraft,
      ) => {
        draft = decide(ctx);
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

  it('cuadrado: guarda contado y diferencia 0, sin motivo, con la fecha de bloqueo del día de la sede', async () => {
    const { close, draft } = build();
    await close.execute(
      's-1',
      {
        counts: [{ currency: 'COP', method: 'CASH', counted: 70_000 }],
        differenceReason: 'No hace falta',
      },
      RECEPTION,
    );
    expect(draft()).toMatchObject({
      hasDifference: false,
      differenceReason: null,
      blind: true,
      suggestedLockDate: '2026-10-17',
      lines: [
        expect.objectContaining({
          countedCents: 7_000_000,
          differenceCents: 0,
        }),
      ],
    });
  });

  it('con diferencia exige motivo (sin decir cuánto: el arqueo puede ser ciego)', async () => {
    const { close } = build();
    await expect(
      close.execute(
        's-1',
        { counts: [{ currency: 'COP', method: 'CASH', counted: 69_000 }] },
        RECEPTION,
      ),
    ).rejects.toThrow(
      new BadRequestException(DIFFERENCE_REASON_REQUIRED_MESSAGE),
    );
  });

  it('con diferencia y motivo: la guarda', async () => {
    const { close, draft } = build();
    await close.execute(
      's-1',
      {
        counts: [{ currency: 'COP', method: 'CASH', counted: 69_000 }],
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
            { currency: 'COP', method: 'CASH', counted: 1 },
            { currency: 'COP', method: 'CASH', counted: 2 },
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
      currency: 'COP',
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
      currency: 'COP',
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
          timeZone: 'America/Bogota',
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
