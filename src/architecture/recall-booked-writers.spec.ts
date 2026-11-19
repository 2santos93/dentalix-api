import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/**
 * DX-465 (D6): al crear una cita del tipo de un recall en su ciclo, el
 * servidor cierra el ciclo en la MISMA transacción
 * (`recallOnAppointmentBookedInTx`). Hay varios escritores de citas (crear,
 * la serie, el sin cita, la oferta de hueco): si aparece otro y no la llama,
 * el paciente al que acaban de agendar sigue contando intentos.
 *
 * Recorre `src/` y lista los ficheros de producción que CREAN citas: Prisma
 * `.appointment.create|createMany|createManyAndReturn|upsert`, creaciones
 * anidadas (`appointments: { create… }`, `appointment: { create… }`) o SQL
 * `INSERT INTO [public.]["]appointments["]`. Cada uno tiene que llamar al
 * hook al menos tantas veces como sitios de creación tiene, o estar exento
 * aquí con el motivo.
 *
 * Límite (revisión DX-465, ruling 8): es textual. No ve una creación que
 * llegue por una función auxiliar de otro fichero ni comprueba que la llamada
 * esté en la misma rama que la creación; los int de cada escritor
 * (recall-attempts, slot-offers, e2e de citas) cubren lo demás.
 */
const SRC = join(__dirname, '..');

const CREATES = new RegExp(
  [
    String.raw`\.appointment\.(?:create|createMany|createManyAndReturn|upsert)\s*\(`,
    String.raw`\bappointments?\s*:\s*\{\s*(?:create|createMany|connectOrCreate|upsert)\b`,
    String.raw`INSERT\s+INTO\s+(?:public\.)?"?appointments"?(?![\w"])`,
  ].join('|'),
  'gi',
);
const HOOK = /recallOnAppointmentBookedInTx\s*\(/g;

/** Sitios de creación y llamadas al hook de un fichero. */
const countOf = (re: RegExp, source: string) => [...source.matchAll(re)].length;

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
    .filter((file) => countOf(CREATES, readFileSync(file, 'utf8')) > 0)
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
    const missing = writers
      .filter((file) => !(file in EXEMPT))
      .map((file) => {
        const source = readFileSync(join(SRC, file), 'utf8');
        return {
          file,
          creates: countOf(CREATES, source),
          hooks: countOf(HOOK, source),
        };
      })
      .filter((w) => w.hooks < w.creates);
    expect(missing).toEqual([]);
  });

  it('control: ve un INSERT con esquema, una creación anidada y un segundo alta sin su llamada', () => {
    expect(countOf(CREATES, 'INSERT INTO public."appointments" (id)')).toBe(1);
    expect(countOf(CREATES, 'INSERT INTO appointments (id)')).toBe(1);
    expect(countOf(CREATES, 'INSERT INTO "appointments_x" (id)')).toBe(0);
    expect(
      countOf(CREATES, 'data: { appointments: { create: [{ start }] } }'),
    ).toBe(1);
    const two =
      'tx.appointment.create({}); recallOnAppointmentBookedInTx(tx, {}); tx.appointment.create({});';
    expect(countOf(CREATES, two)).toBeGreaterThan(countOf(HOOK, two));
  });
});
