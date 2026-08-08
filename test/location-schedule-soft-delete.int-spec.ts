import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import { PrismaLocationScheduleRepository } from '../src/modules/location-schedule/infrastructure/repositories/prisma-location-schedule.repository';
import { HardDeleteForbiddenError } from '../src/shared/prisma/no-hard-delete';

// Conexión de administración (DIRECT_URL, sin RLS) sólo para sembrar y para
// mirar la tabla POR DEBAJO del repositorio: es la única forma de comprobar que
// los tramos viejos siguen ahí y no fueron borrados de verdad.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaLocationScheduleRepository(prisma, tenantContext);

const TZ = 'America/Bogota';
const MORNING = { weekday: 1, startMinute: 9 * 60, endMinute: 13 * 60 };
const AFTERNOON = { weekday: 1, startMinute: 15 * 60, endMinute: 19 * 60 };
const SATURDAY = { weekday: 6, startMinute: 8 * 60, endMinute: 12 * 60 };

describe('Horario de sede: los tramos se retiran en blando (int)', () => {
  let tenantId: string;
  let locationId: string;

  beforeAll(async () => {
    await prisma.onModuleInit();
    const tenant = await raw.tenant.create({
      data: { name: 'Clínica Horarios', subdomain: 'horarios-soft-delete' },
      select: { id: true },
    });
    tenantId = tenant.id;
    const location = await raw.location.create({
      data: { tenantId, name: 'Sede única' },
      select: { id: true },
    });
    locationId = location.id;
  });

  afterAll(async () => {
    await raw.locationScheduleRange.deleteMany({ where: { tenantId } });
    await raw.locationSchedule.deleteMany({ where: { tenantId } });
    await raw.location.deleteMany({ where: { tenantId } });
    await raw.tenant.deleteMany({ where: { id: tenantId } });
    await raw.$disconnect();
    await prisma.onModuleDestroy();
  });

  function asClinic<T>(fn: () => Promise<T>): Promise<T> {
    return tenantContext.run(tenantId, locationId, fn);
  }

  it('guarda el horario, lo reemplaza, y el reemplazo NO borra los tramos viejos', async () => {
    await asClinic(() =>
      repo.replaceForCurrentLocation({
        timezone: TZ,
        ranges: [MORNING, AFTERNOON],
      }),
    );

    const primeros = await raw.locationScheduleRange.findMany({
      where: { tenantId },
    });
    expect(primeros).toHaveLength(2);
    expect(primeros.every((r) => r.deletedAt === null)).toBe(true);

    // Segundo guardado: la clínica cambia a "sólo sábados por la mañana".
    const despues = await asClinic(() =>
      repo.replaceForCurrentLocation({ timezone: TZ, ranges: [SATURDAY] }),
    );

    // Lo que ve la aplicación: sólo el horario NUEVO.
    expect(despues.ranges).toEqual([SATURDAY]);

    // Lo que hay realmente en la tabla: los 2 viejos marcados + el nuevo vivo.
    // Éste es el punto de todo el cambio — antes esta consulta devolvía 1 fila
    // porque las otras dos habían desaparecido con un DELETE.
    const todas = await raw.locationScheduleRange.findMany({
      where: { tenantId },
      orderBy: [{ createdAt: 'asc' }, { startMinute: 'asc' }],
    });
    expect(todas).toHaveLength(3);
    expect(todas.filter((r) => r.deletedAt !== null)).toHaveLength(2);
    expect(todas.filter((r) => r.deletedAt === null)).toHaveLength(1);

    // Y el horario que regía antes sigue siendo reconstruible desde la tabla.
    const historico = todas
      .filter((r) => r.deletedAt !== null)
      .map((r) => ({
        weekday: r.weekday,
        startMinute: r.startMinute,
        endMinute: r.endMinute,
      }));
    expect(historico).toEqual(
      expect.arrayContaining([
        expect.objectContaining(MORNING),
        expect.objectContaining(AFTERNOON),
      ]),
    );
  });

  it('las lecturas devuelven sólo los tramos vivos', async () => {
    const porSede = await asClinic(() => repo.findByLocation(locationId));
    const enContexto = await asClinic(() => repo.findForCurrentLocation());

    expect(porSede?.ranges).toEqual([SATURDAY]);
    expect(enContexto?.ranges).toEqual([SATURDAY]);
  });

  it('la guardia bloquea un borrado duro dentro de runWithTenant', async () => {
    await expect(
      prisma.runWithTenant(tenantId, (tx) =>
        tx.locationScheduleRange.deleteMany({ where: { tenantId } }),
      ),
    ).rejects.toThrow(HardDeleteForbiddenError);

    // Y no borró nada: las 3 filas siguen ahí.
    const todas = await raw.locationScheduleRange.findMany({
      where: { tenantId },
    });
    expect(todas).toHaveLength(3);
  });

  it('la base rechaza borrar el horario padre en duro (FK Restrict, ya no Cascade)', async () => {
    const schedule = await raw.locationSchedule.findFirstOrThrow({
      where: { tenantId },
      select: { id: true },
    });

    // Antes esto se llevaba los 3 tramos por delante en silencio.
    await expect(
      raw.locationSchedule.delete({ where: { id: schedule.id } }),
    ).rejects.toThrow();

    const todas = await raw.locationScheduleRange.findMany({
      where: { tenantId },
    });
    expect(todas).toHaveLength(3);
  });
});
