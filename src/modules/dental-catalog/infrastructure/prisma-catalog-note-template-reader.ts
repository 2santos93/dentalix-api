import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../shared/prisma/prisma.service';
import type { CatalogNoteTemplateReader } from '../domain/ports/catalog-note-template-reader.port';

@Injectable()
export class PrismaCatalogNoteTemplateReader implements CatalogNoteTemplateReader {
  constructor(private readonly prisma: PrismaService) {}

  find(
    id: string,
  ): Promise<{ id: string; name: string; active: boolean } | null> {
    return this.prisma.runWithTenant((tx) =>
      tx.clinicalNoteTemplate.findFirst({
        where: { id },
        select: { id: true, name: true, active: true },
      }),
    );
  }
}
