import type { TenantContextService } from '../../../shared/tenancy/tenant-context.service';
import type { ClinicExportsUseCases } from '../application/clinic-exports.use-cases';
import { ClinicExportsController } from './clinic-exports.controller';

/**
 * DX-053: el controlador traduce el token a «quién pide»: el acceso de
 * soporte (break-glass) y un token con sedes (`loc`) llegan marcados al caso
 * de uso, que los rechaza con 403.
 */
describe('ClinicExportsController (DX-053)', () => {
  const tenantContext = {
    getTenantId: () => 't1',
    getLocationId: () => 'l1',
  } as unknown as TenantContextService;

  function setup() {
    const list = jest.fn(() => Promise.resolve([]));
    const controller = new ClinicExportsController(
      { list } as unknown as ClinicExportsUseCases,
      tenantContext,
    );
    return { controller, list };
  }

  const req = (user: Record<string, unknown>) =>
    ({
      user: { sub: 'u1', tenantId: 't1', role: 'ADMIN', ...user },
      ip: '190.202.15.7',
      headers: { 'user-agent': 'Chrome' },
    }) as never;

  it('un ADMIN normal: sin marcas', async () => {
    const t = setup();
    await t.controller.list(req({}));
    expect(t.list).toHaveBeenCalledWith(
      expect.objectContaining({
        breakGlass: false,
        restrictedToLocations: false,
      }),
    );
  });

  it('break-glass y token con sedes llegan marcados', async () => {
    const t = setup();
    await t.controller.list(req({ breakGlass: true }));
    await t.controller.list(req({ loc: ['l1'] }));
    expect(t.list).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ breakGlass: true }),
    );
    expect(t.list).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ restrictedToLocations: true }),
    );
  });
});
