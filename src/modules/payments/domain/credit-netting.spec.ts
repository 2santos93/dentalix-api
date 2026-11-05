import { netUnallocated } from './credit-netting';

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
    const net = netUnallocated([pay('a', '2026-10-01', 3000)], []);
    expect(net.get('a')).toEqual({ netCents: 3000, creditOutCents: 0 });
  });

  it('una devolución parcial reduce el abono; una total lo deja en 0', () => {
    expect(
      netUnallocated(
        [pay('a', '2026-10-01', 3000)],
        [out('2026-10-05', 1000)],
      ).get('a'),
    ).toEqual({ netCents: 2000, creditOutCents: 1000 });
    expect(
      netUnallocated(
        [pay('a', '2026-10-01', 3000)],
        [out('2026-10-05', 3000)],
      ).get('a'),
    ).toEqual({ netCents: 0, creditOutCents: 3000 });
  });

  it('empieza por el abono más reciente y nunca baja de 0', () => {
    const net = netUnallocated(
      [pay('old', '2026-10-01', 4000), pay('new', '2026-10-02', 4000)],
      [out('2026-10-10', 3000)],
    );
    expect(net.get('new')).toEqual({ netCents: 1000, creditOutCents: 3000 });
    expect(net.get('old')).toEqual({ netCents: 4000, creditOutCents: 0 });
    const more = netUnallocated(
      [pay('old', '2026-10-01', 4000), pay('new', '2026-10-02', 4000)],
      [out('2026-10-10', 6000)],
    );
    expect(more.get('new')?.netCents).toBe(0);
    expect(more.get('old')).toEqual({ netCents: 2000, creditOutCents: 2000 });
  });

  it('una salida no neta un abono POSTERIOR a ella', () => {
    const net = netUnallocated(
      [pay('oct', '2026-10-01', 3000), pay('nov', '2026-11-01', 5000)],
      [out('2026-10-15', 3000)],
    );
    expect(net.get('oct')?.netCents).toBe(0);
    expect(net.get('nov')).toEqual({ netCents: 5000, creditOutCents: 0 });
  });

  it('un abono con paidAt anterior pero registrado DESPUÉS de la salida no se neta', () => {
    const late = {
      ...pay('late', '2026-10-01', 2000),
      createdAt: day('2026-10-20'),
    };
    const net = netUnallocated([late], [out('2026-10-15', 2000)]);
    expect(net.get('late')).toEqual({ netCents: 2000, creditOutCents: 0 });
  });

  it('cada plan con sus salidas, y lo que no encuentra abono se descarta', () => {
    const net = netUnallocated(
      [pay('a', '2026-10-01', 1000, 'p1'), pay('b', '2026-10-01', 1000, 'p2')],
      [out('2026-10-05', 5000, 'p1')],
    );
    expect(net.get('a')).toEqual({ netCents: 0, creditOutCents: 1000 });
    expect(net.get('b')).toEqual({ netCents: 1000, creditOutCents: 0 });
  });
});
