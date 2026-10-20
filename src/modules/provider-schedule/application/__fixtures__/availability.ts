import type { LocationRepository } from '../../../locations/domain/ports/location-repository.port';
import { ProviderAvailabilityService } from '../provider-availability.service';
import { InMemoryProviderScheduleRepository } from './in-memory-provider-schedule.repository';

/**
 * `ProviderAvailabilityService` real sobre un repositorio en memoria. Sin
 * horarios cargados, nadie tiene restricción: es exactamente el
 * comportamiento de antes de DX-233 (lo usan los tests de la agenda que no
 * tratan del horario del profesional). `repo` permite cargar uno.
 */
export function inMemoryAvailability(
  repo = new InMemoryProviderScheduleRepository(),
  timeZone = 'America/Bogota',
): ProviderAvailabilityService {
  const locations = {
    findById: (id: string) =>
      Promise.resolve({ id, name: 'Sede', timeZone, isActive: true }),
  } as unknown as LocationRepository;
  return new ProviderAvailabilityService(repo, locations);
}
