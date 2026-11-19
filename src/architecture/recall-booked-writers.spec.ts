import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-465 (D6): al crear una cita del tipo de un recall en su ciclo, el
 * servidor cierra el ciclo en la MISMA transacción
 * (`recallOnAppointmentBookedInTx`). Hay varios escritores de citas (crear,
 * la serie, el sin cita, la oferta de hueco): si aparece otro y no la llama,
 * el paciente al que acaban de agendar sigue contando intentos.
 *
 * Recorre `src/` y lista los ficheros de producción que CREAN citas (Prisma
 * `.appointment.create|createMany…` o SQL `INSERT INTO "appointments"`). Cada
 * uno tiene que llamar al hook o estar exento aquí con el motivo.
 */
const SRC = join(__dirname, '..');

const CREATES =
  /\.appointment\.(create|createMany|createManyAndReturn|upsert)\s*\(|INSERT INTO\s+"appointments"/;
const HOOK = /recallOnAppointmentBookedInTx\s*\(/;

const EXEMPT: Record<string, string> = {
  'modules/appointments/application/appointment-overlap-error.ts':
    'solo lo nombra en un comentario (la traducción del solape)',
  'modules/jobs/application/job-queue.service.ts':
    'solo lo nombra en el ejemplo de un comentario',
};

function tsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return tsFiles(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

const isProduction = (file: string): boolean =>
  !file.endsWith('.spec.ts') && !file.split(sep).includes('__fixtures__');

const rel = (file: string) => relative(SRC, file).split(sep).join('/');

describe('escritores de citas y el cierre del recall (DX-465, D6)', () => {
  const writers = tsFiles(SRC)
    .filter(isProduction)
    .filter((file) => CREATES.test(readFileSync(file, 'utf8')))
    .map(rel)
    .sort();

  it('encuentra los escritores conocidos (la guarda no está vacía)', () => {
    expect(writers).toEqual(
      [
        'modules/appointments/infrastructure/repositories/prisma-appointment-series.repository.ts',
        'modules/appointments/infrastructure/repositories/prisma-appointment.repository.ts',
        'modules/appointments/infrastructure/repositories/prisma-walk-in.repository.ts',
        'modules/waitlist/infrastructure/repositories/prisma-slot-offer.repository.ts',
        ...Object.keys(EXEMPT),
      ].sort(),
    );
  });

  it('cada fichero que crea citas cierra el ciclo del recall o está exento con motivo', () => {
    const missing = writers.filter(
      (file) =>
        !(file in EXEMPT) && !HOOK.test(readFileSync(join(SRC, file), 'utf8')),
    );
    expect(missing).toEqual([]);
  });
});
