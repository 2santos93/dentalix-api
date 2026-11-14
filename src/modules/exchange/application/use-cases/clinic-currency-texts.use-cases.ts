import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import {
  CURRENCY_DIGITS_CATALOG,
  type CurrencyDigitsCatalog,
} from '../../../../shared/money/currency-digits';
import {
  currencyTextEntries,
  parseCurrencyTextEntries,
  type CurrencyTextEntry,
} from '../../domain/clinic-currency-texts';
import {
  CLINIC_CURRENCY_TEXTS_REPOSITORY,
  type ClinicCurrencyTextsRepository,
} from '../../domain/ports/clinic-currency-texts-repository.port';

export interface ClinicCurrencyTextsView {
  entries: CurrencyTextEntry[];
}

@Injectable()
export class GetClinicCurrencyTextsUseCase {
  constructor(
    @Inject(CLINIC_CURRENCY_TEXTS_REPOSITORY)
    private readonly repo: ClinicCurrencyTextsRepository,
  ) {}

  async execute(): Promise<ClinicCurrencyTextsView> {
    return { entries: currencyTextEntries(await this.repo.get()) };
  }
}

/**
 * DX-517: sustituye el mapa entero (solo ADMIN, lo exige la ruta). Cada
 * código tiene que estar en `currencies`; el texto, de 1 a 8 caracteres en
 * una línea. Lista vacía = nada configurado. Aplica desde ya a pantallas,
 * impresos y mensajes; los recibos ya emitidos conservan su foto.
 */
@Injectable()
export class UpdateClinicCurrencyTextsUseCase {
  constructor(
    @Inject(CLINIC_CURRENCY_TEXTS_REPOSITORY)
    private readonly repo: ClinicCurrencyTextsRepository,
    @Inject(CURRENCY_DIGITS_CATALOG)
    private readonly catalog: CurrencyDigitsCatalog,
  ) {}

  async execute(
    entries: readonly { currency: string; text: string }[],
    ctx: AuditRequestContext,
  ): Promise<ClinicCurrencyTextsView> {
    const codes = entries.map((e) => e.currency.trim().toUpperCase());
    const table = await this.catalog.table(codes);
    const parsed = parseCurrencyTextEntries(entries, (code) => table.has(code));
    if (!parsed.ok) throw new BadRequestException(parsed.message);
    const saved = await this.repo.set(parsed.texts, ctx);
    return { entries: currencyTextEntries(saved) };
  }
}
