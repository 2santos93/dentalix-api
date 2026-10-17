import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import {
  SUPPORT_ACCESS_REPOSITORY,
  type SupportAccessRepository,
} from '../domain/ports/support-access-repository.port';
import {
  decodeSupportAccessCursor,
  encodeSupportAccessCursor,
  type SupportAccess,
} from '../domain/support-access';

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

export interface ListSupportAccessesInput {
  limit?: number;
  cursor?: string;
}

export interface SupportAccessesPage {
  items: SupportAccess[];
  nextCursor: string | null;
}

/** «Accesos de soporte» de la clínica (SEC-008), paginados por cursor. */
@Injectable()
export class ListSupportAccessesUseCase {
  constructor(
    @Inject(SUPPORT_ACCESS_REPOSITORY)
    private readonly repo: SupportAccessRepository,
  ) {}

  async execute(input: ListSupportAccessesInput): Promise<SupportAccessesPage> {
    const limit = input.limit ?? DEFAULT_LIMIT;
    const after = input.cursor ? decodeSupportAccessCursor(input.cursor) : null;
    if (input.cursor && !after) {
      throw new BadRequestException('Cursor inválido');
    }
    // Una fila de más dice si hay otra página sin un COUNT.
    const rows = await this.repo.list(limit + 1, after);
    const items = rows.slice(0, limit);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor:
        rows.length > limit && last
          ? encodeSupportAccessCursor({
              createdAt: last.createdAt,
              id: last.id,
            })
          : null,
    };
  }
}
