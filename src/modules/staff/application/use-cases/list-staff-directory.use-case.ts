import { Inject, Injectable } from '@nestjs/common';
import { STAFF_REPOSITORY } from '../../domain/ports/staff-repository.port';
import type { StaffRepository } from '../../domain/ports/staff-repository.port';
import {
  StaffDirectoryPage,
  StaffDirectoryQuery,
} from '../../domain/entities/staff-directory-entry.entity';

@Injectable()
export class ListStaffDirectoryUseCase {
  constructor(
    @Inject(STAFF_REPOSITORY) private readonly repo: StaffRepository,
  ) {}

  execute(query: StaffDirectoryQuery): Promise<StaffDirectoryPage> {
    // Una búsqueda de solo espacios no es una búsqueda: se descarta aquí para
    // que el repositorio no monte un `contains ''` que no filtra nada pero sí
    // desactiva el camino rápido.
    const search = query.search?.trim();
    return this.repo.listDirectory({
      ...query,
      search: search ? search : undefined,
    });
  }
}
