/**
 * `Promise.allSettled(items.map(fn))` con como mucho `limit` llamadas en
 * curso: cuando una termina (bien o mal) empieza la siguiente. El resultado va
 * en el orden de `items`, no en el de llegada.
 */
export async function settleWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`El límite debe ser un entero ≥ 1 (${limit})`);
  }
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: 'fulfilled', value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: 'rejected', reason };
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}
