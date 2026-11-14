/** Reloj inyectable de los enlaces de pago (DX-569): los tests lo fijan. */
export const PAYMENT_LINKS_CLOCK = Symbol('PAYMENT_LINKS_CLOCK');
export type PaymentLinksClock = () => Date;
