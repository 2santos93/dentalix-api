import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  NO_CURRENCY_TEXTS,
  readCurrencyTexts,
  type CurrencyTexts,
} from '../format/currency-text';

/**
 * DX-517: el texto propio de cada moneda de una clínica, para los mensajes
 * que la API formatea (recordatorio con la política de cancelación y su vista
 * previa). `tenants` es global (sin RLS): se lee por id. Una clínica que no
 * existe no tiene textos.
 */
@Injectable()
export class ClinicCurrencyTextsReader {
  constructor(private readonly prisma: PrismaService) {}

  async forTenant(tenantId: string): Promise<CurrencyTexts> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { currencyTexts: true },
    });
    return tenant ? readCurrencyTexts(tenant.currencyTexts) : NO_CURRENCY_TEXTS;
  }
}
