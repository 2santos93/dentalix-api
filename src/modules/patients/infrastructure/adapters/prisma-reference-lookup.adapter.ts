import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../shared/prisma/prisma.service';
import { ReferenceLookup } from '../../domain/ports/reference-lookup.port';

@Injectable()
export class PrismaReferenceLookup implements ReferenceLookup {
  constructor(private readonly prisma: PrismaService) {}

  async cityBelongsToCountry(
    cityId: number,
    countryCode: string,
  ): Promise<boolean> {
    const city = await this.prisma.city.findUnique({
      where: { id: cityId },
      select: { countryCode: true },
    });
    return city?.countryCode === countryCode;
  }
}
