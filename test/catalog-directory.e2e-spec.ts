import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';

// `raw` es la conexión de ADMINISTRACIÓN (DIRECT_URL, superuser) para
// sembrar y limpiar: con RLS aplicado, una conexión sin contexto de tenant no
// vería ninguna fila y no podría limpiar lo que dejaron otros specs. Mismo
// patrón que inventory.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PASSWORD = 'S3cret!!';
const SUBDOMAIN = 'catalogo-directorio';

interface LoginBody {
  accessToken: string;
}
interface CatalogItemBody {
  id: string;
  code: string;
  labelEs: string;
  kind: 'DIAGNOSIS' | 'PROCEDURE';
  active: boolean;
}
interface DirectoryBody {
  items: CatalogItemBody[];
  total: number;
  page: number;
  pageSize: number;
}

async function cleanup(): Promise<void> {
  await raw.toothRecord.deleteMany();
  await raw.treatmentPlanItem.deleteMany();
  await raw.treatmentPlan.deleteMany();
  await raw.dentalCatalogItem.deleteMany();
  await raw.patient.deleteMany();
  await raw.location.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Catálogo · GET /catalog/items/directory (e2e)', () => {
  let app: INestApplication<App>;
  let token: string;
  const host = hostFor(SUBDOMAIN);

  const auth = (r: request.Test) =>
    r.set('X-Tenant-Host', host).set('Authorization', `Bearer ${token}`);

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    await cleanup();

    await registerVerified(app, {
      clinicName: 'Clínica Catálogo',
      subdomain: SUBDOMAIN,
      email: 'admin@catalogo.test',
      password: PASSWORD,
      fullName: 'Dr. Owner',
    });
    const login = await request(app.getHttpServer())
      .post('/api/v1/auth/login')
      .set('X-Tenant-Host', host)
      .send({ email: 'admin@catalogo.test', password: PASSWORD })
      .expect(201);
    token = (login.body as LoginBody).accessToken;

    // Una clínica nueva nace con el catálogo por defecto sembrado (~97 ítems,
    // ver DEFAULT_DENTAL_CATALOG). Se vacía aquí para que los totales de abajo
    // sean exactos y legibles: si no, cada aserción tendría que ir contra una
    // línea base que cambia cada vez que alguien añade un procedimiento al
    // catálogo semilla, y el test fallaría por un motivo que no es el suyo.
    await raw.dentalCatalogItem.deleteMany();

    // 25 procedimientos + 1 diagnóstico inactivo. 25 pasa del tamaño de página
    // por defecto (20) a propósito: sin eso, "paginado" y "sin paginar" darían
    // el mismo resultado y el test no probaría nada.
    for (let i = 1; i <= 25; i++) {
      const n = String(i).padStart(2, '0');
      await auth(request(app.getHttpServer()).post('/api/v1/catalog/items'))
        .send({
          code: `P-${n}`,
          kind: 'PROCEDURE',
          labelEs: i === 7 ? 'Endodoncia unirradicular' : `Procedimiento ${n}`,
          color: '#0E7490',
        })
        .expect(201);
    }
    await auth(request(app.getHttpServer()).post('/api/v1/catalog/items'))
      .send({
        code: 'D-01',
        kind: 'DIAGNOSIS',
        labelEs: 'Caries oclusal',
        color: '#BE123C',
        active: false,
      })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('devuelve la primera página con el total completo, no el de la página', async () => {
    const res = await auth(
      request(app.getHttpServer()).get('/api/v1/catalog/items/directory'),
    ).expect(200);
    const body = res.body as DirectoryBody;

    expect(body.items).toHaveLength(20);
    expect(body).toMatchObject({ total: 26, page: 1, pageSize: 20 });
    // Orden por código: la primera página empieza en D-01 (diagnóstico) porque
    // "D" va antes que "P".
    expect(body.items[0].code).toBe('D-01');
  });

  it('la segunda página trae el resto y no repite filas de la primera', async () => {
    const first = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?page=1',
      ),
    ).expect(200);
    const second = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?page=2',
      ),
    ).expect(200);

    const firstCodes = (first.body as DirectoryBody).items.map((i) => i.code);
    const secondBody = second.body as DirectoryBody;

    expect(secondBody.items).toHaveLength(6);
    expect(secondBody.page).toBe(2);
    expect(
      secondBody.items.filter((i) => firstCodes.includes(i.code)),
    ).toHaveLength(0);
  });

  it('busca por etiqueta y por código, sin distinguir mayúsculas', async () => {
    const porEtiqueta = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?query=ENDODONCIA',
      ),
    ).expect(200);
    const porCodigo = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?query=d-01',
      ),
    ).expect(200);

    expect((porEtiqueta.body as DirectoryBody).total).toBe(1);
    expect((porEtiqueta.body as DirectoryBody).items[0].code).toBe('P-07');
    expect((porCodigo.body as DirectoryBody).items[0].labelEs).toBe(
      'Caries oclusal',
    );
  });

  it('el total refleja la BÚSQUEDA, no el catálogo entero', async () => {
    const res = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?query=Procedimiento',
      ),
    ).expect(200);
    const body = res.body as DirectoryBody;

    // 25 procedimientos menos el que se renombró a "Endodoncia unirradicular".
    expect(body.total).toBe(24);
    // Y sigue paginando dentro de ese universo, no del completo.
    expect(body.items).toHaveLength(20);
  });

  it('combina búsqueda con los filtros de tipo y de activos', async () => {
    const soloDiagnosticos = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?kind=DIAGNOSIS',
      ),
    ).expect(200);
    const soloActivos = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?activeOnly=true',
      ),
    ).expect(200);

    expect((soloDiagnosticos.body as DirectoryBody).total).toBe(1);
    // El diagnóstico se creó inactivo, así que activeOnly lo deja fuera.
    expect((soloActivos.body as DirectoryBody).total).toBe(25);
  });

  it('acota pageSize: pedir 5000 no se lleva la tabla entera', async () => {
    const res = await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?pageSize=5000',
      ),
    ).expect(200);

    expect((res.body as DirectoryBody).pageSize).toBe(100);
  });

  it('rechaza una página inválida en vez de aceptarla en silencio', async () => {
    await auth(
      request(app.getHttpServer()).get(
        '/api/v1/catalog/items/directory?page=0',
      ),
    ).expect(400);
  });

  it('no toca GET /catalog/items: los selectores siguen recibiendo el catálogo entero', async () => {
    const res = await auth(
      request(app.getHttpServer()).get('/api/v1/catalog/items'),
    ).expect(200);

    // Un array pelado, sin envoltorio, con las 26 filas. Este es el contrato
    // del que dependen el odontograma y el plan de tratamiento.
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body as CatalogItemBody[]).toHaveLength(26);
  });
});
