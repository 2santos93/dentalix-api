// Reloj inyectable de la cobranza (DX-150): las specs fijan «ahora»; producción
// usa el real.
export type CollectionsClock = () => Date;
export const COLLECTIONS_CLOCK = Symbol('COLLECTIONS_CLOCK');
