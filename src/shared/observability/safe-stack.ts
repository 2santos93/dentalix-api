/**
 * Stacks aptos para el log (DX-023). `error.stack` empieza por
 * "Nombre: mensaje", y el mensaje puede llevar datos: los de Prisma imprimen
 * la query con sus argumentos (el nombre del paciente, su documento...) y un
 * `new Error(\`... ${dato}\`)` lleva lo que el código interpoló. Solo los
 * marcos "at ..." son seguros, así que es lo único que se conserva.
 */
export function stackFrames(error: Error): string[] {
  return (error.stack ?? '').split('\n').filter((line) => /^\s+at /.test(line));
}

/** `header` (por defecto el nombre del error) seguido de los marcos. */
export function stackWithoutMessage(
  error: Error,
  header: string = error.name,
): string {
  return [header, ...stackFrames(error)].join('\n');
}
