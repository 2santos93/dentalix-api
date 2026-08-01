import { Inject, Injectable } from '@nestjs/common';
import { PLATFORM_REPOSITORY } from '../../domain/ports/platform-repository.port';
import type {
  PlatformRepository,
  PlatformTenant,
} from '../../domain/ports/platform-repository.port';

@Injectable()
export class ListTenantsUseCase {
  constructor(
    @Inject(PLATFORM_REPOSITORY) private readonly repo: PlatformRepository,
  ) {}

  execute(): Promise<PlatformTenant[]> {
    return this.repo.listTenants();
  }
}
