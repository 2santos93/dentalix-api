import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { ClinicRole, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { PasswordService } from '../src/shared/crypto/password.service';
import { hostFor } from './support/tenant-host';

// `raw` es una conexión de ADMINISTRACIÓN exclusiva para seed/cleanup -- usa
// DIRECT_URL (rol owner `dentalix`, superuser) porque, con RLS aplicado, una
// conexión sin contexto de tenant (rol dentalix_app vía DATABASE_URL) ve 0
// filas y no podría sembrar/limpiar datos ajenos al tenant. Mismo patrón que
// sales.e2e-spec.ts / treatment-plans.e2e-spec.ts / role-matrix.e2e-spec.ts.
const raw = new PrismaClient({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const passwordService = new PasswordService();
const SEEDED_PASSWORD = 'S3cret!!';

interface RegisterResponseBody {
  tenantId: string;
  userId: string;
}

interface LoginResponseBody {
  accessToken: string;
  refreshToken: string;
}

interface InventoryMovementResponseBody {
  id: string;
  itemId: string;
  type: string;
  quantity: number;
}

interface InventoryItemResponseBody {
  id: string;
  name: string;
  unit: string;
  minStock: number;
  stock?: number;
  lowStock?: boolean;
  movements?: InventoryMovementResponseBody[];
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
): Promise<{
  tenantId: string;
  userId: string;
  accessToken: string;
  subdomain: string;
}> {
  const register = await request(app.getHttpServer())
    .post('/api/v1/auth/register')
    .send({
      clinicName: opts.clinicName,
      subdomain: opts.subdomain,
      email: opts.email,
      password: SEEDED_PASSWORD,
      fullName: 'Dr. Owner',
    })
    .expect(201);
  const registerBody = register.body as RegisterResponseBody;

  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: SEEDED_PASSWORD,
    })
    .expect(201);
  const loginBody = login.body as LoginResponseBody;

  return {
    tenantId: registerBody.tenantId,
    userId: registerBody.userId,
    accessToken: loginBody.accessToken,
    subdomain: opts.subdomain,
  };
}

// Siembra un usuario con contraseña hasheada igual que el registro, más su
// membresía en la clínica (tenant) dada, con el rol pedido. Usa el cliente
// `raw` (DIRECT_URL, superuser) porque bypassa RLS -- no hay endpoint de
// invitación de staff todavía (mismo patrón que sales.e2e-spec.ts /
// role-matrix.e2e-spec.ts).
async function seedRoledMember(
  tenantId: string,
  email: string,
  role: ClinicRole,
  fullName: string,
): Promise<{ userId: string }> {
  const passwordHash = await passwordService.hash(SEEDED_PASSWORD);
  const user = await raw.user.create({
    data: {
      email,
      passwordHash,
      fullName,
      emailVerifiedAt: new Date(),
    },
    select: { id: true },
  });
  await raw.clinicMembership.create({
    data: { tenantId, userId: user.id, role },
  });
  return { userId: user.id };
}

async function loginAs(
  app: INestApplication<App>,
  opts: { subdomain: string; email: string },
): Promise<string> {
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({
      email: opts.email,
      password: SEEDED_PASSWORD,
    })
    .expect(201);
  return (login.body as LoginResponseBody).accessToken;
}

async function cleanup(): Promise<void> {
  // FK-safe order: InventoryMovement -> InventoryItem (onDelete: Restrict)
  // -> ClinicMembership -> User -> Tenant.
  await raw.inventoryMovement.deleteMany();
  await raw.inventoryItem.deleteMany();
  await raw.clinicMembership.deleteMany();
  await raw.user.deleteMany();
  await raw.tenant.deleteMany();
}

describe('Inventory (e2e)', () => {
  let app: INestApplication<App>;

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
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it(
    'creates an item, tracks computed stock/low-stock across movements, ' +
      'validates movement input, updates/soft-deletes items, isolates ' +
      'tenants and enforces INVENTORY_ROLES',
    async () => {
      const subdomainA = 'clinica-inventory-a';
      const clinicA = await registerAndLogin(app, {
        clinicName: 'Clinica Inventory A',
        subdomain: subdomainA,
        email: 'owner@clinica-inventory-a.com',
      });

      // --- 1. POST /inventory/items { name, unit, minStock: 5 } -> 201.
      const createRes = await request(app.getHttpServer())
        .post('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ name: 'Guantes de nitrilo', unit: 'caja', minStock: 5 })
        .expect(201);
      const item = createRes.body as InventoryItemResponseBody;
      expect(item.name).toBe('Guantes de nitrilo');
      expect(item.minStock).toBe(5);

      // --- 2. GET /inventory/items -> that item, stock=0, lowStock=true
      // (0 <= 5, no movements yet).
      const list1 = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const items1 = list1.body as InventoryItemResponseBody[];
      const listed1 = items1.find((i) => i.id === item.id);
      expect(listed1?.stock).toBe(0);
      expect(listed1?.lowStock).toBe(true);

      // --- 3. POST .../movements { type: IN, quantity: 10 } -> 201 ->
      // GET items -> stock=10, lowStock=false (10 > 5).
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ type: 'IN', quantity: 10 })
        .expect(201);

      const list2 = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const listed2 = (list2.body as InventoryItemResponseBody[]).find(
        (i) => i.id === item.id,
      );
      expect(listed2?.stock).toBe(10);
      expect(listed2?.lowStock).toBe(false);

      // --- 4. POST .../movements { type: OUT, quantity: 7 } -> stock=3,
      // lowStock=true (3 <= 5).
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ type: 'OUT', quantity: 7 })
        .expect(201);

      const list3 = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const listed3 = (list3.body as InventoryItemResponseBody[]).find(
        (i) => i.id === item.id,
      );
      expect(listed3?.stock).toBe(3);
      expect(listed3?.lowStock).toBe(true);

      // --- 5. POST .../movements { type: ADJUSTMENT, quantity: -1 } ->
      // stock=2 (3 + (-1)).
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ type: 'ADJUSTMENT', quantity: -1 })
        .expect(201);

      // --- 6. GET /inventory/items/:id -> stock=2 + 3 movements listed;
      // GET .../movements -> 3.
      const getItem = await request(app.getHttpServer())
        .get(`/api/v1/inventory/items/${item.id}`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const detail = getItem.body as InventoryItemResponseBody;
      expect(detail.stock).toBe(2);
      expect(detail.movements).toHaveLength(3);

      const movementsRes = await request(app.getHttpServer())
        .get(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      expect(
        (movementsRes.body as InventoryMovementResponseBody[]).length,
      ).toBe(3);

      // --- 7. IN with quantity 0 -> 400; ADJUSTMENT with quantity 0 ->
      // 400 (RecordInventoryMovementUseCase validation).
      await request(app.getHttpServer())
        .post(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ type: 'IN', quantity: 0 })
        .expect(400);

      await request(app.getHttpServer())
        .post(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ type: 'ADJUSTMENT', quantity: 0 })
        .expect(400);

      // Neither rejected movement was persisted -- still 3.
      const movementsAfterRejects = await request(app.getHttpServer())
        .get(`/api/v1/inventory/items/${item.id}/movements`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      expect(
        (movementsAfterRejects.body as InventoryMovementResponseBody[]).length,
      ).toBe(3);

      // --- 8. PATCH item (minStock -> 1) -> GET reflects lowStock=false
      // (stock 2 > minStock 1).
      await request(app.getHttpServer())
        .patch(`/api/v1/inventory/items/${item.id}`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .send({ minStock: 1 })
        .expect(200);

      const list4 = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      const listed4 = (list4.body as InventoryItemResponseBody[]).find(
        (i) => i.id === item.id,
      );
      expect(listed4?.minStock).toBe(1);
      expect(listed4?.stock).toBe(2);
      expect(listed4?.lowStock).toBe(false);

      // --- 9. Tenant isolation: clinic B (different subdomain) does not
      // see clinic A's (still-active) item -> 404 (RLS makes a
      // cross-tenant row indistinguishable from absent, see
      // GetInventoryItemUseCase). Checked BEFORE deleting the item so this
      // exercises isolation, not "item happens to be gone for everyone".
      const subdomainB = 'clinica-inventory-b';
      const clinicB = await registerAndLogin(app, {
        clinicName: 'Clinica Inventory B',
        subdomain: subdomainB,
        email: 'owner@clinica-inventory-b.com',
      });

      await request(app.getHttpServer())
        .get(`/api/v1/inventory/items/${item.id}`)
        .set('X-Tenant-Host', hostFor(subdomainB))
        .set('Authorization', `Bearer ${clinicB.accessToken}`)
        .expect(404);

      // --- 10. DELETE item -> soft-deleted -> excluded from GET
      // /inventory/items; GET by id now 404s the same way a cross-tenant
      // row does (see GetInventoryItemUseCase).
      await request(app.getHttpServer())
        .delete(`/api/v1/inventory/items/${item.id}`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);

      const list5 = await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(200);
      expect(
        (list5.body as InventoryItemResponseBody[]).map((i) => i.id),
      ).not.toContain(item.id);

      await request(app.getHttpServer())
        .get(`/api/v1/inventory/items/${item.id}`)
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${clinicA.accessToken}`)
        .expect(404);

      // --- 11. Roles: RECEPTION is not in INVENTORY_ROLES -> 403 on POST
      // and GET; OWNER (already proven above) + a seeded ASSISTANT -> OK.
      await seedRoledMember(
        clinicA.tenantId,
        'reception@clinica-inventory-a.com',
        ClinicRole.RECEPTION,
        'Seeded RECEPTION',
      );
      const receptionToken = await loginAs(app, {
        subdomain: subdomainA,
        email: 'reception@clinica-inventory-a.com',
      });

      await request(app.getHttpServer())
        .post('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${receptionToken}`)
        .send({ name: 'Intento recepcion', unit: 'unidad' })
        .expect(403);

      await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${receptionToken}`)
        .expect(403);

      await seedRoledMember(
        clinicA.tenantId,
        'assistant@clinica-inventory-a.com',
        ClinicRole.ASSISTANT,
        'Seeded ASSISTANT',
      );
      const assistantToken = await loginAs(app, {
        subdomain: subdomainA,
        email: 'assistant@clinica-inventory-a.com',
      });

      await request(app.getHttpServer())
        .get('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${assistantToken}`)
        .expect(200);

      const assistantCreate = await request(app.getHttpServer())
        .post('/api/v1/inventory/items')
        .set('X-Tenant-Host', hostFor(subdomainA))
        .set('Authorization', `Bearer ${assistantToken}`)
        .send({ name: 'Alcohol antiseptico', unit: 'ml' })
        .expect(201);
      expect((assistantCreate.body as InventoryItemResponseBody).name).toBe(
        'Alcohol antiseptico',
      );
    },
  );
});
