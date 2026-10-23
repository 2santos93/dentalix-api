/**
 * Reloj de la anamnesis por enlace (DX-099): caducidad del enlace y estado
 * efectivo. Un proveedor propio para que los e2e lo adelanten (como
 * POSTOP_CLOCK).
 */
export const ANAMNESIS_CLOCK = Symbol('ANAMNESIS_CLOCK');
export type AnamnesisClock = () => Date;
