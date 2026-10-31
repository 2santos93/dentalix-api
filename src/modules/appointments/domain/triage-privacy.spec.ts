import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// DX-470: las señales y la nota de triaje son datos de salud. Solo las leen
// la cita (GET /appointments/:id), «Atender sin cita» y el panel «En
// clínica» (personal con acceso a la sede); nunca las vistas públicas
// (confirmación, ofertas de hueco, anamnesis o firma por enlace), los
// recordatorios, los mensajes salientes ni la agenda de contingencia. Este
// guard falla si un fichero de producción nuevo las nombra: quien lo
// necesite tiene que añadirlo aquí a propósito (y revisarlo).

const SRC = join(__dirname, '../../..');

const ALLOWED = new Set([
  'modules/appointments/domain/walk-in.ts',
  'modules/appointments/domain/entities/appointment.entity.ts',
  'modules/appointments/domain/ports/walk-in-repository.port.ts',
  'modules/appointments/application/use-cases/create-walk-in.use-case.ts',
  'modules/appointments/application/use-cases/list-in-clinic.use-case.ts',
  'modules/appointments/infrastructure/repositories/prisma-appointment.repository.ts',
  'modules/appointments/infrastructure/repositories/prisma-walk-in.repository.ts',
  'modules/appointments/presentation/appointments.controller.ts',
  'modules/appointments/presentation/dto/appointment.dto.ts',
  'modules/appointments/presentation/dto/in-clinic.dto.ts',
  'modules/appointments/presentation/dto/walk-in.dto.ts',
  // Redacta el triaje de cualquier log estructurado.
  'shared/observability/redact.ts',
]);

function productionFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === '__fixtures__' ? [] : productionFiles(path);
    }
    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });
}

describe('triaje fuera de vistas públicas, recordatorios y logs (DX-470)', () => {
  it('solo los ficheros de la lista nombran el triaje', () => {
    const naming = productionFiles(SRC)
      .filter((file) => /triage/i.test(readFileSync(file, 'utf8')))
      .map((file) => relative(SRC, file).split('\\').join('/'))
      .sort();
    expect(naming).toEqual([...ALLOWED].sort());
  });
});
