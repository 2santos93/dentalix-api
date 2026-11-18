/** Reloj inyectable (las specs fijan «ahora»); producción usa el real. */
export type PatientAccessClock = () => Date;
export const PATIENT_ACCESS_CLOCK = Symbol('PATIENT_ACCESS_CLOCK');

/** Espera inyectable del suelo de tiempo de los fallos (las specs no esperan). */
export type PatientAccessSleeper = (ms: number) => Promise<void>;
export const PATIENT_ACCESS_SLEEPER = Symbol('PATIENT_ACCESS_SLEEPER');

/** Clave HMAC de la cookie de sesión del portal (derivada del secreto). */
export const PATIENT_ACCESS_SESSION_KEY = Symbol('PATIENT_ACCESS_SESSION_KEY');
