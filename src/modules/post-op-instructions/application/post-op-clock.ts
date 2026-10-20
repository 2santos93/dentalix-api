/**
 * Reloj del módulo (DX-222): la caducidad de los enlaces públicos se calcula
 * con él, y los e2e lo sobrescriben para adelantar el tiempo.
 */
export const POSTOP_CLOCK = Symbol('POSTOP_CLOCK');
export type PostOpClock = () => Date;
