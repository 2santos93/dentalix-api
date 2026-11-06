import { settleWithLimit } from './settle-with-limit';

const tick = () => new Promise((r) => setImmediate(r));

describe('settleWithLimit (OPS-056)', () => {
  it('nunca pasa del límite y devuelve en el orden de entrada', async () => {
    let running = 0;
    let peak = 0;
    const results = await settleWithLimit([3, 1, 2, 1, 3], 2, async (n) => {
      running++;
      peak = Math.max(peak, running);
      for (let i = 0; i < n; i++) await tick();
      running--;
      return n * 10;
    });
    expect(peak).toBe(2);
    expect(results).toEqual(
      [30, 10, 20, 10, 30].map((value) => ({ status: 'fulfilled', value })),
    );
  });

  it('un fallo (también síncrono) sale como rejected y no corta a las demás', async () => {
    const boom = new Error('caída');
    const results = await settleWithLimit([1, 2, 3], 1, (n) => {
      if (n === 1) throw boom;
      if (n === 2) return Promise.reject(boom);
      return Promise.resolve(n);
    });
    expect(results).toEqual([
      { status: 'rejected', reason: boom },
      { status: 'rejected', reason: boom },
      { status: 'fulfilled', value: 3 },
    ]);
  });

  it('sin elementos no llama a nada; un límite inválido es un error', async () => {
    const fn = jest.fn();
    await expect(settleWithLimit([], 2, fn)).resolves.toEqual([]);
    expect(fn).not.toHaveBeenCalled();
    await expect(settleWithLimit([1], 0, fn)).rejects.toThrow(RangeError);
  });
});
