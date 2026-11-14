import { netCredit, netUnallocated } from './credit-netting';

const day = (d: string) => new Date(`${d}T12:00:00.000Z`);
const pay = (id: string, d: string, un: number, planId = 'plan-1') => ({
  id,
  planId,
  paidAt: day(d),
  createdAt: day(d),
  unallocatedCents: un,
});
const out = (d: string, cents: number, planId = 'plan-1') => ({
  planId,
  createdAt: day(d),
  cents,
});

describe('netUnallocated (DX-399)', () => {
  it('sin salidas, todo sigue a cuenta', () => {
    const net = netUnallocated([pay('a', '2026-10-01', 3000)], [], []);
    expect(net.get('a')).toEqual({ netCents: 3000, creditOutCents: 0 });
  });

  it('una devolución parcial reduce el abono; una total lo deja en 0', () => {
    expect(
      netUnallocated(
        [pay('a', '2026-10-01', 3000)],
        [out('2026-10-05', 1000)],
        [],
      ).get('a'),
    ).toEqual({ netCents: 2000, creditOutCents: 1000 });
    expect(
      netUnallocated(
        [pay('a', '2026-10-01', 3000)],
        [out('2026-10-05', 3000)],
        [],
      ).get('a'),
    ).toEqual({ netCents: 0, creditOutCents: 3000 });
  });

  it('empieza por el abono más reciente y nunca baja de 0', () => {
    const net = netUnallocated(
      [pay('old', '2026-10-01', 4000), pay('new', '2026-10-02', 4000)],
      [out('2026-10-10', 3000)],
      [],
    );
    expect(net.get('new')).toEqual({ netCents: 1000, creditOutCents: 3000 });
    expect(net.get('old')).toEqual({ netCents: 4000, creditOutCents: 0 });
    const more = netUnallocated(
      [pay('old', '2026-10-01', 4000), pay('new', '2026-10-02', 4000)],
      [out('2026-10-10', 6000)],
      [],
    );
    expect(more.get('new')?.netCents).toBe(0);
    expect(more.get('old')).toEqual({ netCents: 2000, creditOutCents: 2000 });
  });

  it('una salida no neta un abono POSTERIOR a ella', () => {
    const net = netUnallocated(
      [pay('oct', '2026-10-01', 3000), pay('nov', '2026-11-01', 5000)],
      [out('2026-10-15', 3000)],
      [],
    );
    expect(net.get('oct')?.netCents).toBe(0);
    expect(net.get('nov')).toEqual({ netCents: 5000, creditOutCents: 0 });
  });

  it('un abono con paidAt anterior pero registrado DESPUÉS de la salida no se neta', () => {
    const late = {
      ...pay('late', '2026-10-01', 2000),
      createdAt: day('2026-10-20'),
    };
    const net = netUnallocated([late], [out('2026-10-15', 2000)], []);
    expect(net.get('late')).toEqual({ netCents: 2000, creditOutCents: 0 });
  });

  it('cada plan con sus salidas, y lo que no encuentra abono se descarta', () => {
    const net = netUnallocated(
      [pay('a', '2026-10-01', 1000, 'p1'), pay('b', '2026-10-01', 1000, 'p2')],
      [out('2026-10-05', 5000, 'p1')],
      [],
    );
    expect(net.get('a')).toEqual({ netCents: 0, creditOutCents: 1000 });
    expect(net.get('b')).toEqual({ netCents: 1000, creditOutCents: 0 });
  });
});

// DX-399-ter: el saldo recibido por traspaso (TRANSFER_IN) absorbe salidas
// ANTES que los abonos, porque no se puede imputar a ítems.
const tin = (id: string, d: string, cents: number, planId = 'plan-1') => ({
  id,
  planId,
  createdAt: day(d),
  cents,
});

describe('netCredit: el saldo recibido por traspaso absorbe primero (DX-399-ter)', () => {
  it('la secuencia del ticket: excedente propio, traspaso recibido, devolución de 30 -> el abono conserva su excedente', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000)],
      [out('2026-10-10', 3000)],
      [tin('t', '2026-10-05', 3000)],
    );
    expect(result.byPayment.get('a')).toEqual({
      netCents: 3000,
      creditOutCents: 0,
    });
    expect(result.byPlan.get('plan-1')).toEqual({
      outCents: 3000,
      absorbedByTransfersInCents: 3000,
      absorbedByPaymentsCents: 0,
      discardedCents: 0,
    });
  });

  it('traspaso parcial: lo que no cubre el traspaso sale del abono más reciente', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000)],
      [out('2026-10-10', 3000)],
      [tin('t', '2026-10-05', 1000)],
    );
    expect(result.byPayment.get('a')).toEqual({
      netCents: 1000,
      creditOutCents: 2000,
    });
    expect(result.byPlan.get('plan-1')).toMatchObject({
      absorbedByTransfersInCents: 1000,
      absorbedByPaymentsCents: 2000,
      discardedCents: 0,
    });
  });

  it('varias devoluciones van agotando primero el traspaso y luego los abonos', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 5000)],
      [
        out('2026-10-10', 1000),
        out('2026-10-11', 1500),
        out('2026-10-12', 1000),
      ],
      [tin('t', '2026-10-05', 2000)],
    );
    expect(result.byPayment.get('a')).toEqual({
      netCents: 3500,
      creditOutCents: 1500,
    });
    expect(result.byPlan.get('plan-1')).toMatchObject({
      outCents: 3500,
      absorbedByTransfersInCents: 2000,
      absorbedByPaymentsCents: 1500,
    });
  });

  it('una devolución mayor que lo recibido por traspaso: el resto va a los abonos y lo que sobre se descarta', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 1000)],
      [out('2026-10-10', 5000)],
      [tin('t', '2026-10-05', 3000)],
    );
    expect(result.byPayment.get('a')).toEqual({
      netCents: 0,
      creditOutCents: 1000,
    });
    expect(result.byPlan.get('plan-1')).toEqual({
      outCents: 5000,
      absorbedByTransfersInCents: 3000,
      absorbedByPaymentsCents: 1000,
      discardedCents: 1000,
    });
  });

  it('F2: un traspaso recibido DESPUÉS de la salida también la absorbe (ida y vuelta): el abono recupera su excedente', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000)],
      [out('2026-10-10', 3000)],
      [tin('t', '2026-10-15', 3000)],
    );
    expect(result.byPayment.get('a')).toEqual({
      netCents: 3000,
      creditOutCents: 0,
    });
    expect(result.byPlan.get('plan-1')?.absorbedByTransfersInCents).toBe(3000);
  });

  it('F2: lo recibido después se gasta una sola vez: la salida posterior que lo vuelve a sacar cae en el abono', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000)],
      [out('2026-10-10', 3000), out('2026-10-20', 3000)],
      [tin('t', '2026-10-15', 3000)],
    );
    expect(result.byPayment.get('a')).toEqual({
      netCents: 0,
      creditOutCents: 3000,
    });
    expect(result.byPlan.get('plan-1')).toEqual({
      outCents: 6000,
      absorbedByTransfersInCents: 3000,
      absorbedByPaymentsCents: 3000,
      discardedCents: 0,
    });
  });

  it('con varios traspasos recibidos, empieza por el más reciente; cada plan con los suyos', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000, 'p1'), pay('b', '2026-10-01', 3000, 'p2')],
      [out('2026-10-10', 2500, 'p1'), out('2026-10-10', 1000, 'p2')],
      [
        tin('t-old', '2026-10-03', 2000, 'p1'),
        tin('t-new', '2026-10-04', 2000, 'p1'),
      ],
    );
    // p1: t-new 2000 + t-old 500; el abono intacto. p2 no tiene traspasos.
    expect(result.byPayment.get('a')).toEqual({
      netCents: 3000,
      creditOutCents: 0,
    });
    expect(result.byPayment.get('b')).toEqual({
      netCents: 2000,
      creditOutCents: 1000,
    });
    expect(result.byPlan.get('p1')).toMatchObject({
      absorbedByTransfersInCents: 2500,
    });
  });

  it('un plan sin traspasos da lo de siempre (LIFO de DX-399, calculado a mano)', () => {
    const payments = [
      pay('old', '2026-10-01', 4000),
      pay('new', '2026-10-02', 4000),
    ];
    const outs = [out('2026-10-10', 6000)];
    const result = netCredit(payments, outs, []);
    // 6000 salen: 4000 del más reciente y 2000 del antiguo.
    expect(result.byPlan.get('plan-1')).toEqual({
      outCents: 6000,
      absorbedByTransfersInCents: 0,
      absorbedByPaymentsCents: 6000,
      discardedCents: 0,
    });
    expect(result.byPayment.get('new')).toEqual({
      netCents: 0,
      creditOutCents: 4000,
    });
    expect(result.byPayment.get('old')).toEqual({
      netCents: 2000,
      creditOutCents: 2000,
    });
  });

  it('una salida sin abonos con excedente la absorbe igual el traspaso (no se descarta)', () => {
    const result = netCredit(
      [],
      [out('2026-10-10', 3000)],
      [tin('t', '2026-10-05', 3000)],
    );
    expect(result.byPlan.get('plan-1')).toMatchObject({
      absorbedByTransfersInCents: 3000,
      discardedCents: 0,
    });
  });
});

// DX-399-quater: lo recibido por traspaso que ninguna salida gastó sigue en el
// plan y cubre ítems. `transfersInLeft` es esa cifra, por plan.
describe('netCredit: lo recibido por traspaso que queda (DX-399-quater)', () => {
  it('sin salidas, queda todo lo recibido, aunque el plan no tenga abonos con excedente', () => {
    const result = netCredit([], [], [tin('t', '2026-10-05', 3000)]);
    expect(result.transfersInLeft.get('plan-1')).toBe(3000);
  });

  it('una salida gasta primero lo recibido: queda solo el resto', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000)],
      [out('2026-10-10', 1000)],
      [tin('t', '2026-10-05', 3000)],
    );
    expect(result.transfersInLeft.get('plan-1')).toBe(2000);
    // El abono no se tocó: lo recibido pagó la salida.
    expect(result.byPayment.get('a')).toEqual({
      netCents: 3000,
      creditOutCents: 0,
    });
  });

  it('traspaso y luego devolución de lo mismo: no queda nada recibido (no se gasta dos veces)', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000)],
      [out('2026-10-10', 3000)],
      [tin('t', '2026-10-05', 3000)],
    );
    expect(result.transfersInLeft.get('plan-1')).toBe(0);
  });

  it('una salida mayor que lo recibido lo deja en 0, nunca en negativo', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 1000)],
      [out('2026-10-10', 5000)],
      [tin('t', '2026-10-05', 3000)],
    );
    expect(result.transfersInLeft.get('plan-1')).toBe(0);
  });

  it('cada plan con lo suyo; un plan sin traspasos no aparece', () => {
    const result = netCredit(
      [pay('a', '2026-10-01', 3000, 'p1'), pay('b', '2026-10-01', 3000, 'p2')],
      [out('2026-10-10', 500, 'p1'), out('2026-10-10', 1000, 'p2')],
      [
        tin('t1', '2026-10-03', 2000, 'p1'),
        tin('t2', '2026-10-04', 1000, 'p1'),
      ],
    );
    expect(result.transfersInLeft.get('p1')).toBe(2500);
    expect(result.transfersInLeft.has('p2')).toBe(false);
  });
});
