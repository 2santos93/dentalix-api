import {
  ORTHO_BILLING_MESSAGES,
  alignerStatus,
  caseAccount,
  coversArch,
  daysBetween,
  plannedCharges,
  validateDelivery,
  validateFee,
  validateOverdueDays,
  validateSeries,
  type ChargeFacts,
} from './ortho-billing';

describe('DX-285 · reparto del honorario', () => {
  it('3.000.000 con inicial de 600.000, 24 controles de 90.000 y retiro de 240.000 cuadra', () => {
    const r = validateFee({
      total: 3_000_000,
      initial: 600_000,
      perVisit: 90_000,
      visitCount: 24,
      retention: 240_000,
    });
    expect(r).toEqual({
      ok: true,
      value: {
        totalCents: 300_000_000,
        initialCents: 60_000_000,
        perVisitCents: 9_000_000,
        visitCount: 24,
        retentionCents: 24_000_000,
      },
    });
  });

  it('un reparto que no suma el total da el mensaje en español', () => {
    const r = validateFee({
      total: 3_000_000,
      initial: 600_000,
      perVisit: 90_000,
      visitCount: 23,
      retention: 240_000,
    });
    expect(r).toEqual({ ok: false, message: ORTHO_BILLING_MESSAGES.feeSplit });
  });

  it('cuadra al céntimo con decimales (USD)', () => {
    expect(
      validateFee({
        total: 2500.5,
        initial: 500.1,
        perVisit: 83.35,
        visitCount: 24,
        retention: 0,
      }).ok,
    ).toBe(true);
    // 0,1 + 0,2: sin error de coma flotante.
    expect(
      validateFee({ total: 0.3, initial: 0.1, retention: 0.2, visitCount: 0 })
        .ok,
    ).toBe(true);
  });

  it.each([
    [{ total: 0 }],
    [{ total: -5 }],
    [{ total: 100, initial: -1, retention: 101 }],
    [{ total: 1.005, initial: 1.005 }],
    [{ total: '3000' }],
    [{ total: Number.NaN }],
  ])('importes inválidos → 400 (%j)', (input) => {
    expect(validateFee(input)).toEqual({
      ok: false,
      message: ORTHO_BILLING_MESSAGES.feeAmounts,
    });
  });

  it.each([[-1], [241], [2.5], ['24']])('controles %p → 400', (visitCount) => {
    expect(validateFee({ total: 10, initial: 10, visitCount })).toEqual({
      ok: false,
      message: ORTHO_BILLING_MESSAGES.feeVisits,
    });
  });

  it('los cargos: inicial, un ítem por control y el retiro; importe 0 no crea ítem', () => {
    const fee = validateFee({
      total: 3_000_000,
      initial: 600_000,
      perVisit: 90_000,
      visitCount: 24,
      retention: 240_000,
    });
    if (!fee.ok) throw new Error(fee.message);
    const charges = plannedCharges(fee.value);
    expect(charges).toHaveLength(26);
    expect(charges[0]).toEqual({
      kind: 'INITIAL',
      sequence: 0,
      priceCents: 60_000_000,
      note: 'Ortodoncia: cuota inicial',
    });
    expect(charges[3]).toMatchObject({
      kind: 'VISIT',
      sequence: 3,
      note: 'Ortodoncia: control 3 de 24',
    });
    expect(charges[25]).toMatchObject({ kind: 'RETENTION', sequence: 0 });

    const noRetention = validateFee({ total: 600, initial: 600 });
    if (!noRetention.ok) throw new Error(noRetention.message);
    expect(plannedCharges(noRetention.value).map((c) => c.kind)).toEqual([
      'INITIAL',
    ]);
  });

  it('el umbral del saldo vencido va de 1 a 365 días enteros', () => {
    expect(validateOverdueDays(30)).toEqual({ ok: true, value: 30 });
    for (const bad of [0, 366, 2.5, '30', null]) {
      expect(validateOverdueDays(bad).ok).toBe(false);
    }
  });
});

describe('DX-285 · cuenta del caso y saldo vencido (reloj fijo)', () => {
  const TODAY = '2026-11-16';
  const charge = (over: Partial<ChargeFacts>): ChargeFacts => ({
    kind: 'VISIT',
    sequence: 1,
    billableCents: 9_000_000,
    paidCents: 0,
    done: false,
    removed: false,
    realizedOn: null,
    ...over,
  });

  it('control 3 de 24: realizado = inicial + 3 × 90.000', () => {
    const charges = [
      charge({
        kind: 'INITIAL',
        sequence: 0,
        billableCents: 60_000_000,
        done: true,
        realizedOn: '2026-11-01',
      }),
      ...[1, 2, 3].map((k) =>
        charge({ sequence: k, done: true, realizedOn: '2026-11-10' }),
      ),
      ...[4, 5].map((k) => charge({ sequence: k })),
    ];
    const r = caseAccount(charges, TODAY, 30);
    expect(r.billedCents).toBe(60_000_000 + 27_000_000);
    expect(r.visitsCharged).toBe(3);
    expect(r.balanceCents).toBe(87_000_000);
    expect(r.overdueCents).toBe(0);
  });

  it('realizado y sin pagar de hace 45 días con umbral 30 → vencido; 30 justos no', () => {
    const old = '2026-10-02'; // 45 días antes de TODAY
    expect(daysBetween(old, TODAY)).toBe(45);
    const r = caseAccount(
      [charge({ done: true, realizedOn: old, paidCents: 1_000_000 })],
      TODAY,
      30,
    );
    expect(r.overdueCents).toBe(8_000_000);
    expect(r.overdueSince).toBe(old);
    expect(r.overdueAgeDays).toBe(45);

    const thirty = caseAccount(
      [charge({ done: true, realizedOn: '2026-10-17' })],
      TODAY,
      30,
    );
    expect(thirty.overdueCents).toBe(0);
  });

  it('con el abono que lo cubre ya no hay vencido', () => {
    const r = caseAccount(
      [charge({ done: true, realizedOn: '2026-10-02', paidCents: 9_000_000 })],
      TODAY,
      30,
    );
    expect(r.overdueCents).toBe(0);
    expect(r.overdueSince).toBeNull();
    expect(r.balanceCents).toBe(0);
  });

  it('lo pagado por adelantado a un control aún no realizado da saldo negativo', () => {
    const r = caseAccount([charge({ paidCents: 9_000_000 })], TODAY, 30);
    expect(r.billedCents).toBe(0);
    expect(r.paidCents).toBe(9_000_000);
    expect(r.balanceCents).toBe(-9_000_000);
  });

  it('un ítem retirado del plan no cuenta y se informa', () => {
    const r = caseAccount(
      [charge({ removed: true, done: true, realizedOn: '2026-09-01' })],
      TODAY,
      30,
    );
    expect(r).toMatchObject({
      billedCents: 0,
      overdueCents: 0,
      removedCharges: 1,
    });
  });
});

describe('DX-285 · alineadores', () => {
  const SERIES = { totalTrays: 20, daysPerTray: 14 };
  const START = '2026-09-01';
  const at = (n: number) => {
    const d = new Date(`${START}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const first = { fromTray: 1, toTray: 4, deliveredOn: START };

  it('sin entregas: sin empezar', () => {
    expect(alignerStatus(SERIES, [], at(10))).toMatchObject({
      state: 'NOT_STARTED',
      currentTray: null,
      lastDeliveredTray: 0,
    });
  });

  it('20 bandejas a 14 días, entregas 1–4 y 5–8: la bandeja sale por fecha', () => {
    const second = { fromTray: 5, toTray: 8, deliveredOn: at(42) };
    const deliveries = [first, second];
    expect(alignerStatus(SERIES, deliveries, START).currentTray).toBe(1);
    expect(alignerStatus(SERIES, deliveries, at(13)).currentTray).toBe(1);
    expect(alignerStatus(SERIES, deliveries, at(14)).currentTray).toBe(2);
    // Entregada pronto (día 42), la 5 empieza al terminar la 4 (día 56).
    expect(alignerStatus(SERIES, deliveries, at(50)).currentTray).toBe(4);
    const day60 = alignerStatus(SERIES, deliveries, at(60));
    expect(day60).toMatchObject({
      state: 'IN_PROGRESS',
      currentTray: 5,
      currentTrayStartedOn: at(56),
      nextChangeOn: at(70),
      lastDeliveredTray: 8,
      // 20 bandejas × 14 días desde el inicio.
      estimatedEndOn: at(280),
    });
  });

  it('no pasa de la última entregada: «Sin bandejas: entregar»', () => {
    const s = alignerStatus(SERIES, [first], at(60));
    expect(s).toMatchObject({
      state: 'NEEDS_DELIVERY',
      currentTray: 4,
      nextChangeOn: at(56),
      lastDeliveredTray: 4,
    });
    // Fin previsto: desde hoy, las 16 que faltan.
    expect(s.estimatedEndOn).toBe(at(60 + 16 * 14));
  });

  it('una entrega tarde: la bandeja empieza el día de la entrega', () => {
    const late = { fromTray: 5, toTray: 8, deliveredOn: at(70) };
    const s = alignerStatus(SERIES, [first, late], at(71));
    expect(s).toMatchObject({ currentTray: 5, currentTrayStartedOn: at(70) });
  });

  it('todas entregadas y usadas: terminada', () => {
    const all = { fromTray: 1, toTray: 20, deliveredOn: START };
    expect(alignerStatus(SERIES, [all], at(400))).toMatchObject({
      state: 'FINISHED',
      currentTray: 20,
      estimatedEndOn: at(280),
    });
  });

  it('las entregas van seguidas, dentro de la serie y con fecha válida', () => {
    const bounds = { caseStart: START, today: at(60) };
    expect(
      validateDelivery(
        { fromTray: 5, toTray: 8, deliveredOn: at(42) },
        SERIES,
        [first],
        bounds,
      ),
    ).toEqual({
      ok: true,
      value: { fromTray: 5, toTray: 8, deliveredOn: at(42) },
    });
    expect(
      validateDelivery(
        { fromTray: 6, toTray: 8, deliveredOn: at(42) },
        SERIES,
        [first],
        bounds,
      ),
    ).toEqual({ ok: false, message: ORTHO_BILLING_MESSAGES.deliveryOrder(5) });
    expect(
      validateDelivery(
        { fromTray: 5, toTray: 21, deliveredOn: at(42) },
        SERIES,
        [first],
        bounds,
      ),
    ).toEqual({
      ok: false,
      message: ORTHO_BILLING_MESSAGES.deliveryBeyond(20),
    });
    for (const deliveredOn of [at(61), '2026-08-31', 'mañana', at(-1)]) {
      expect(
        validateDelivery(
          { fromTray: 5, toTray: 8, deliveredOn },
          SERIES,
          [first],
          bounds,
        ).ok,
      ).toBe(false);
    }
    expect(
      validateDelivery(
        { fromTray: 21, toTray: 21, deliveredOn: at(42) },
        SERIES,
        [{ fromTray: 1, toTray: 20, deliveredOn: START }],
        bounds,
      ),
    ).toEqual({
      ok: false,
      message: ORTHO_BILLING_MESSAGES.deliveryAllDelivered,
    });
  });

  it('la serie: arcada, marca y bandejas en rango', () => {
    expect(
      validateSeries({
        arch: 'BOTH',
        brand: '  Marca X ',
        totalTrays: 20,
        daysPerTray: 14,
      }),
    ).toEqual({
      ok: true,
      value: {
        arch: 'BOTH',
        brand: 'Marca X',
        totalTrays: 20,
        daysPerTray: 14,
      },
    });
    const bad = validateSeries({
      arch: 'MIDDLE',
      brand: '',
      totalTrays: 100,
      daysPerTray: 0,
    });
    expect(bad.ok).toBe(false);
    expect(coversArch('BOTH', 'UPPER')).toBe(true);
    expect(coversArch('LOWER', 'UPPER')).toBe(false);
  });
});
