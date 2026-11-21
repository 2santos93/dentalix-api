import { Inject, Injectable } from '@nestjs/common';
import { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import {
  currencyNotAccepted,
  isAcceptedCurrency,
} from '../domain/clinic-currencies';
import {
  CLINIC_CURRENCIES_REPOSITORY,
  type ClinicCurrenciesRepository,
} from '../domain/ports/clinic-currencies-repository.port';

/**
 * DX-584: el alta de un abono (suelto, dividido y las líneas del vuelto) solo
 * admite las monedas que acepta la clínica. Lista vacía = cualquiera (lo de
 * antes). Los abonos ya registrados no se tocan: es una regla del alta.
 */
@Injectable()
export class AcceptedCurrenciesGate {
  constructor(
    @Inject(CLINIC_CURRENCIES_REPOSITORY)
    private readonly currencies: ClinicCurrenciesRepository,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * 400 `CURRENCY_NOT_ACCEPTED` con la primera moneda (ya normalizada) que la
   * clínica no acepta. Una lectura de `tenants` por llamada: pásale todas las
   * monedas del cobro de una vez.
   */
  async assertAccepted(currencies: readonly string[]): Promise<void> {
    if (currencies.length === 0) return;
    if (this.tenantContext.getTenantId() === undefined) return;
    const settings = await this.currencies.get();
    const rejected = currencies.find((c) => !isAcceptedCurrency(settings, c));
    if (rejected !== undefined) throw currencyNotAccepted(rejected);
  }
}
