import { ForbiddenException } from '@nestjs/common';
import { TenantContextService } from './tenant-context.service';

describe('TenantContextService', () => {
  const svc = new TenantContextService();

  it('returns undefined outside a context', () => {
    expect(svc.getTenantId()).toBeUndefined();
  });

  it('exposes the tenant id inside run()', () => {
    const seen = svc.run('tenant-123', () => svc.getTenantId());
    expect(seen).toBe('tenant-123');
  });

  it('isolates nested contexts', () => {
    const outer = svc.run('a', () => {
      const inner = svc.run('b', () => svc.getTenantId());
      return { inner, outer: svc.getTenantId() };
    });
    expect(outer).toEqual({ inner: 'b', outer: 'a' });
  });
});

describe('TenantContextService — sedes permitidas (DX-089)', () => {
  const svc = new TenantContextService();

  /** `tx` falso: `location.findFirst` devuelve la primera sede de `active` que esté en el `in`. */
  function makeTx(active: string[]) {
    const findFirst = jest.fn(
      ({ where }: { where: { id?: { in: string[] } } }) => {
        const hit = active.find((id) => !where.id || where.id.in.includes(id));
        return Promise.resolve(hit ? { id: hit } : null);
      },
    );
    return { tx: { location: { findFirst } } as never, findFirst };
  }

  it('sin restricción y fuera de contexto → ALL', () => {
    expect(svc.getAllowedLocationIds()).toBe('ALL');
    expect(svc.run('t', () => svc.getAllowedLocationIds())).toBe('ALL');
    expect(svc.run('t', undefined, () => svc.getAllowedLocationIds())).toBe(
      'ALL',
    );
  });

  it('expone la lista permitida pasada a run()', () => {
    expect(
      svc.run('t', undefined, () => svc.getAllowedLocationIds(), ['a', 'b']),
    ).toEqual(['a', 'b']);
  });

  describe('locationScope', () => {
    it('con cabecera → esa sede', () => {
      expect(svc.run('t', 'a', () => svc.locationScope(), ['a', 'b'])).toEqual({
        locationId: 'a',
      });
    });

    it('restringido sin cabecera → solo sus sedes', () => {
      expect(
        svc.run('t', undefined, () => svc.locationScope(), ['a', 'b']),
      ).toEqual({ locationId: { in: ['a', 'b'] } });
    });

    it('sin restricción y sin cabecera → sin filtro (vista consolidada)', () => {
      expect(svc.run('t', undefined, () => svc.locationScope())).toEqual({});
    });

    it('loc = [] → filtro vacío: las lecturas no devuelven nada', () => {
      expect(svc.run('t', undefined, () => svc.locationScope(), [])).toEqual({
        locationId: { in: [] },
      });
    });
  });

  describe('scopeLocationIds', () => {
    it('con cabecera → [cabecera]', () => {
      expect(svc.run('t', 'a', () => svc.scopeLocationIds(), ['a'])).toEqual([
        'a',
      ]);
    });

    it('restringido sin cabecera → sus sedes', () => {
      expect(
        svc.run('t', undefined, () => svc.scopeLocationIds(), ['a', 'b']),
      ).toEqual(['a', 'b']);
    });

    it('sin restricción y sin cabecera → undefined (sin restricción)', () => {
      expect(svc.run('t', undefined, () => svc.scopeLocationIds())).toBe(
        undefined,
      );
    });
  });

  describe('assertLocationAllowed', () => {
    it('sin restricción no lanza', () => {
      expect(() =>
        svc.run('t', () => svc.assertLocationAllowed('x')),
      ).not.toThrow();
    });

    it('sede permitida no lanza', () => {
      expect(() =>
        svc.run('t', undefined, () => svc.assertLocationAllowed('a'), ['a']),
      ).not.toThrow();
    });

    it('sede no permitida → 403 con code LOCATION_NOT_ALLOWED', () => {
      let caught: unknown;
      try {
        svc.run('t', undefined, () => svc.assertLocationAllowed('b'), ['a']);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(ForbiddenException);
      expect((caught as ForbiddenException).getResponse()).toMatchObject({
        statusCode: 403,
        code: 'LOCATION_NOT_ALLOWED',
        message: 'No tienes acceso a esta sede.',
      });
    });
  });

  describe('writeLocationId', () => {
    it('con cabecera → la cabecera, sin consultar', async () => {
      const { tx, findFirst } = makeTx(['z']);
      await expect(
        svc.run('t', 'a', () => svc.writeLocationId(tx), ['a']),
      ).resolves.toBe('a');
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('restringido sin cabecera → la primera sede permitida ACTIVA por antigüedad', async () => {
      const { tx, findFirst } = makeTx(['otra', 'b', 'a']);
      await expect(
        svc.run('t', undefined, () => svc.writeLocationId(tx), ['a', 'b']),
      ).resolves.toBe('b');
      expect(findFirst).toHaveBeenCalledWith({
        where: { id: { in: ['a', 'b'] }, isActive: true, deletedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { id: true },
      });
    });

    it('sin restricción y sin cabecera → la sede por defecto de la clínica', async () => {
      const { tx } = makeTx(['principal']);
      await expect(
        svc.run('t', undefined, () => svc.writeLocationId(tx)),
      ).resolves.toBe('principal');
    });

    it('loc = [] → 403 «No tienes ninguna sede activa asignada.»', async () => {
      const { tx, findFirst } = makeTx(['principal']);
      const err = await svc
        .run('t', undefined, () => svc.writeLocationId(tx), [])
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        code: 'LOCATION_NOT_ALLOWED',
        message: 'No tienes ninguna sede activa asignada.',
      });
      expect(findFirst).not.toHaveBeenCalled();
    });

    it('restringido con todas sus sedes ya inactivas → el mismo 403 (nunca la sede por defecto)', async () => {
      const { tx } = makeTx(['principal']);
      const err = await svc
        .run('t', undefined, () => svc.writeLocationId(tx), ['a'])
        .catch((e: unknown) => e);
      expect((err as ForbiddenException).getResponse()).toMatchObject({
        message: 'No tienes ninguna sede activa asignada.',
      });
    });
  });
});
