/**
 * DX-252: «día/mes» de los mensajes de la API (bloqueos de agenda). El
 * formateador de la sede (`Intl.DateTimeFormat('es-CO', { day: '2-digit',
 * month: '2-digit' })`) quita el cero del día Y del mes con el ICU de Node 22
 * («5/1», «3/11»), así que los tests capturan uno o dos dígitos en cada campo y
 * comparan números, nunca el relleno: así no dependen de la fecha del día.
 */
export const DAY_MONTH = String.raw`(\d{1,2})\/(\d{1,2})`;

/** `[día, mes]` como números de un `YYYY-MM-DD`. */
export function dayMonthNumbers(isoDay: string): [number, number] {
  return [Number(isoDay.slice(8, 10)), Number(isoDay.slice(5, 7))];
}
