/**
 * Reloj de la firma a distancia (DX-243): caducidad del enlace, del código y
 * de la sesión, y la hora de la firma. Un proveedor propio para que los e2e lo
 * adelanten (como ANAMNESIS_CLOCK).
 */
export const SIGNATURE_CLOCK = Symbol('SIGNATURE_CLOCK');
export type SignatureClock = () => Date;

/**
 * Clave del HMAC del código de verificación, derivada de un secreto del
 * servidor (ver `deriveSignatureCodeKey`).
 */
export const SIGNATURE_CODE_KEY = Symbol('SIGNATURE_CODE_KEY');
