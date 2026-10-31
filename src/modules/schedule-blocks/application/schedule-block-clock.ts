/**
 * DX-446: reloj de la agenda para decidir si un hueco reservado ya se liberó
 * («Liberar a partir de» en la hora de la sede). Inyectable: los tests fijan
 * la hora, nunca dependen del reloj real.
 */
export type ScheduleBlockClock = () => Date;
export const SCHEDULE_BLOCK_CLOCK = Symbol('SCHEDULE_BLOCK_CLOCK');
export const systemScheduleBlockClock: ScheduleBlockClock = () => new Date();
