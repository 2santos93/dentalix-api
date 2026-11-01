import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { AuditRequestContext } from '../../../audit/domain/audit-request-context';
import type {
  LocationReceiptLegendView,
  ReceiptSettingsRepository,
} from '../../domain/ports/receipt-settings-repository.port';
import type {
  ClinicReceiptSettings,
  LocationReceiptLegend,
} from '../../domain/receipt-settings';
import {
  GetReceiptSettingsUseCase,
  RECEIPT_SETTINGS_LOCATION_NOT_FOUND_MESSAGE,
  UpdateLocationReceiptLegendUseCase,
  UpdateReceiptSettingsUseCase,
} from './receipt-settings.use-cases';

const CTX: AuditRequestContext = {
  tenantId: 't1',
  locationId: null,
  actor: { userId: 'u1', role: 'ADMIN' },
  requestId: null,
  ip: null,
  userAgent: null,
};

class FakeRepo implements ReceiptSettingsRepository {
  clinic: ClinicReceiptSettings = { title: null, legend: null };
  locations: LocationReceiptLegendView[] = [
    {
      locationId: 'loc-1',
      name: 'Sede 1',
      isActive: true,
      override: false,
      legend: null,
    },
  ];
  setClinicCalls: ClinicReceiptSettings[] = [];
  setLocationCalls: { id: string; next: LocationReceiptLegend }[] = [];

  getClinic() {
    return Promise.resolve(this.clinic);
  }
  listLocations() {
    return Promise.resolve(this.locations);
  }
  setClinic(next: ClinicReceiptSettings) {
    this.setClinicCalls.push(next);
    this.clinic = next;
    return Promise.resolve(next);
  }
  setLocation(id: string, next: LocationReceiptLegend) {
    this.setLocationCalls.push({ id, next });
    const found = this.locations.find((l) => l.locationId === id);
    if (!found) return Promise.resolve(null);
    Object.assign(found, next);
    return Promise.resolve(found);
  }
}

describe('ajustes del recibo (DX-515)', () => {
  it('lee los de la clínica y la leyenda de cada sede', async () => {
    const repo = new FakeRepo();
    repo.clinic = { title: 'Recibo de pago', legend: null };
    await expect(
      new GetReceiptSettingsUseCase(repo).execute(),
    ).resolves.toEqual({
      title: 'Recibo de pago',
      legend: null,
      locations: repo.locations,
    });
  });

  it('guarda recortado y deja null lo vacío', async () => {
    const repo = new FakeRepo();
    await new UpdateReceiptSettingsUseCase(repo).execute(
      { title: '  Recibo de pago ', legend: '   ' },
      CTX,
    );
    expect(repo.setClinicCalls).toEqual([
      { title: 'Recibo de pago', legend: null },
    ]);
  });

  it('400 con salto de línea o pasado el tope, sin escribir', async () => {
    const repo = new FakeRepo();
    const uc = new UpdateReceiptSettingsUseCase(repo);
    await expect(
      uc.execute({ title: 'a\nb', legend: null }, CTX),
    ).rejects.toThrow(BadRequestException);
    await expect(
      uc.execute({ title: null, legend: 'x'.repeat(251) }, CTX),
    ).rejects.toThrow(BadRequestException);
    await expect(
      uc.execute({ title: 'x'.repeat(61), legend: null }, CTX),
    ).rejects.toThrow(BadRequestException);
    expect(repo.setClinicCalls).toEqual([]);
  });

  it('la leyenda de la sede: sin override la descarta; con override vacía = ninguna', async () => {
    const repo = new FakeRepo();
    const uc = new UpdateLocationReceiptLegendUseCase(repo);
    await uc.execute('loc-1', { override: false, legend: 'ignorada' }, CTX);
    await uc.execute('loc-1', { override: true, legend: '' }, CTX);
    await uc.execute('loc-1', { override: true, legend: ' Propia ' }, CTX);
    expect(repo.setLocationCalls.map((c) => c.next)).toEqual([
      { override: false, legend: null },
      { override: true, legend: null },
      { override: true, legend: 'Propia' },
    ]);
  });

  it('una sede que no es de la clínica: 404 en español', async () => {
    const uc = new UpdateLocationReceiptLegendUseCase(new FakeRepo());
    await expect(
      uc.execute('otra', { override: true, legend: 'x' }, CTX),
    ).rejects.toThrow(
      new NotFoundException(RECEIPT_SETTINGS_LOCATION_NOT_FOUND_MESSAGE),
    );
  });
});
