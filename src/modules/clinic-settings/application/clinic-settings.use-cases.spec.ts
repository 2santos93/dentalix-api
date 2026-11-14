import { BadRequestException } from '@nestjs/common';
import type { AuditRequestContext } from '../../audit/domain/audit-request-context';
import {
  CurrencyDigitsTable,
  type CurrencyDigitsCatalog,
} from '../../../shared/money/currency-digits';
import {
  CLINIC_SETTINGS_MESSAGES,
  type ClinicProfilePatch,
} from '../domain/clinic-settings';
import type {
  ClinicSettingsRepository,
  StoredClinicSettings,
} from '../domain/ports/clinic-settings-repository.port';
import { UpdateClinicSettingsUseCase } from './clinic-settings.use-cases';

// DX-502-bis: la moneda del catálogo se valida contra la referencia de
// monedas (`currencies`), no solo por su forma.
const KNOWN = ['USD', 'VES', 'EUR'];
const catalog: CurrencyDigitsCatalog = {
  table: (codes) =>
    Promise.resolve(
      new CurrencyDigitsTable(
        (codes ?? KNOWN)
          .filter((code) => KNOWN.includes(code))
          .map((code) => ({ code, minorUnits: 2, roundingDigits: 2 })),
      ),
    ),
};

const ctx = {} as AuditRequestContext;

function repo(): ClinicSettingsRepository & { patches: ClinicProfilePatch[] } {
  let stored: StoredClinicSettings = {
    profile: {
      name: 'Sonrisas',
      legalName: null,
      taxId: null,
      taxIdLabel: null,
      fiscalAddress: null,
      contactEmail: null,
      contactPhone: null,
      primaryColor: '#0E7490',
      catalogCurrency: null,
    },
    logoKey: null,
  };
  const patches: ClinicProfilePatch[] = [];
  return {
    patches,
    get: () => Promise.resolve(stored),
    updateProfile: (patch) => {
      patches.push(patch);
      stored = { ...stored, profile: { ...stored.profile, ...patch } };
      return Promise.resolve(stored);
    },
    setLogo: () => Promise.resolve(stored),
  };
}

describe('UpdateClinicSettingsUseCase: moneda del catálogo (DX-502-bis)', () => {
  it('guarda una moneda de la referencia y la devuelve', async () => {
    const r = repo();
    const view = await new UpdateClinicSettingsUseCase(r, catalog).execute(
      { catalogCurrency: 'usd' },
      ctx,
    );
    expect(view.catalogCurrency).toBe('USD');
    expect(r.patches).toEqual([{ catalogCurrency: 'USD' }]);
  });

  it('una moneda con forma ISO que no está en la referencia: 400 y no guarda nada', async () => {
    const r = repo();
    await expect(
      new UpdateClinicSettingsUseCase(r, catalog).execute(
        { catalogCurrency: 'XYZ' },
        ctx,
      ),
    ).rejects.toThrow(
      new BadRequestException(CLINIC_SETTINGS_MESSAGES.catalogCurrency),
    );
    expect(r.patches).toEqual([]);
  });

  it('null la quita sin mirar la referencia', async () => {
    const r = repo();
    const view = await new UpdateClinicSettingsUseCase(r, catalog).execute(
      { catalogCurrency: null },
      ctx,
    );
    expect(view.catalogCurrency).toBeNull();
    expect(r.patches).toEqual([{ catalogCurrency: null }]);
  });

  it('sin moneda en el cambio, el resto se guarda igual que antes', async () => {
    const r = repo();
    await new UpdateClinicSettingsUseCase(r, catalog).execute(
      { taxId: 'J-12345678-9' },
      ctx,
    );
    expect(r.patches).toEqual([{ taxId: 'J-12345678-9' }]);
  });
});
