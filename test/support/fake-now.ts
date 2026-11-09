/**
 * DX-460: `E2E_FAKE_NOW=<instante ISO>` desplaza el reloj de ESTE proceso (el
 * spec y la API montada en él) para correr una suite «a las 04:45 UTC» (la
 * medianoche de la sede, cuando fusiona el loop) sin libfaketime. Solo mueve
 * `Date` (`new Date()` sin argumentos y `Date.now()`): el `now()` de Postgres
 * (defaults y triggers) sigue siendo el real y la zona del proceso no cambia.
 * Sin la variable no hace nada. Solo pruebas.
 *
 *   E2E_FAKE_NOW=2026-11-09T04:45:00Z npm run test:e2e -- test/cash-register
 */
export function installFakeNow(
  raw: string | undefined = process.env.E2E_FAKE_NOW,
): void {
  if (!raw) return;
  const target = Date.parse(raw);
  if (Number.isNaN(target)) {
    throw new Error(`E2E_FAKE_NOW no es un instante ISO: ${raw}`);
  }
  const RealDate = Date;
  const offset = target - RealDate.now();
  const now = () => RealDate.now() + offset;
  globalThis.Date = new Proxy(RealDate, {
    construct(Target, args: unknown[], newTarget) {
      return Reflect.construct(
        Target,
        args.length === 0 ? [now()] : args,
        newTarget,
      ) as Date;
    },
    // `Date()` sin `new`: la fecha de ahora como texto.
    apply(Target) {
      return new Target(now()).toString();
    },
    get(Target, property, receiver) {
      return property === 'now'
        ? now
        : (Reflect.get(Target, property, receiver) as unknown);
    },
  });
}
