import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import request from 'supertest';
import { App } from 'supertest/types';
import { Prisma, PrismaClient } from '@prisma/client';
import { AppModule } from '../src/app.module';
import { hostFor } from './support/tenant-host';
import { registerVerified } from './support/register-verified';
import { resetDatabase } from './support/e2e-fixtures';
import {
  REGIONAL_BERLIN_FIXTURE,
  REGIONAL_BOGOTA_FIXTURE,
  REGIONAL_NEW_YORK_FIXTURE,
  REGIONAL_TOKYO_FIXTURE,
  g1LocationInsert,
  legacyLocationInsert,
  locationBody,
  registerBody,
} from './support/location-fixtures';

const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

const PASSWORD = 'S3cret!!';

interface RegisterBody {
  tenantId: string;
}
interface LoginBody {
  accessToken: string;
}
interface LocationBody {
  id: string;
  name: string;
  isActive: boolean;
}
interface AppointmentBody {
  id: string;
}

async function registerAndLogin(
  app: INestApplication<App>,
  opts: { clinicName: string; subdomain: string; email: string },
) {
  const register = await registerVerified(
    app,
    registerBody(REGIONAL_BOGOTA_FIXTURE, {
      ...opts,
      password: PASSWORD,
      fullName: 'Dr. Owner',
    }),
  );
  const login = await request(app.getHttpServer())
    .post('/api/v1/auth/login')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .send({ email: opts.email, password: PASSWORD })
    .expect(201);
  const accessToken = (login.body as LoginBody).accessToken;
  // Este spec no prueba el horario de atención, y una sede nueva nace con uno por
  // defecto (lun-vie 9-13/15-19, sáb 9-13). Un PUT con `ranges: []` deja la sede
  // SIN restricción, así que agendar no depende de la hora/día de la corrida.
  await request(app.getHttpServer())
    .put('/api/v1/locations/schedule')
    .set('X-Tenant-Host', hostFor(opts.subdomain))
    .set('Authorization', `Bearer ${accessToken}`)
    .send({ ranges: [] })
    .expect(200);
  return {
    tenantId: (register.body as RegisterBody).tenantId,
    accessToken,
    subdomain: opts.subdomain,
  };
}

async function cleanup(): Promise<void> {
  await resetDatabase(raw);
}

describe('Locations / multi-sede (e2e)', () => {
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
    await app.listen(0, '127.0.0.1');
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await app.close();
    await raw.$disconnect();
  });

  it('G1 DTOs type every regional field in OpenAPI (never an empty object)', () => {
    // Sin `type: String`, un `string | null` sale como `type: object` y la web
    // genera `Record<string, never>` para ese campo.
    const swagger = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().build(),
    );
    const schemas = swagger.components?.schemas ?? {};
    const untyped: string[] = [];
    for (const dto of [
      'LocationDto',
      'CreateLocationDto',
      'UpdateLocationDto',
      'RegisterDto',
      'CurrencyDto',
      'CreateTreatmentPlanDto',
      'ReplaceLocationScheduleDto',
      'ProviderLocationScheduleDto',
    ]) {
      const schema = schemas[dto] as
        { properties?: Record<string, Record<string, unknown>> } | undefined;
      expect(schema?.properties).toBeDefined();
      for (const [name, property] of Object.entries(schema!.properties!)) {
        if (property.type === 'object' && !property.properties) {
          untyped.push(`${dto}.${name}`);
        }
      }
    }
    expect(untyped).toEqual([]);
    const update = (
      schemas.UpdateLocationDto as {
        properties: Record<string, { type?: string }>;
      }
    ).properties;
    expect(
      ['currency', 'timeZone', 'locale', 'hourCycle'].map(
        (f) => update[f].type,
      ),
    ).toEqual(['string', 'string', 'string', 'string']);
    // G1-B: el reloj es un enum también en la respuesta, anulable en fase 1.
    const dto = (
      schemas.LocationDto as {
        properties: Record<string, Record<string, unknown>>;
      }
    ).properties.hourCycle;
    expect(dto).toMatchObject({
      type: 'string',
      nullable: true,
      enum: ['h12', 'h23', null],
    });
    for (const [schema, field] of [
      ['CreateLocationDto', 'hourCycle'],
      ['UpdateLocationDto', 'hourCycle'],
      ['RegisterDto', 'locationHourCycle'],
    ] as const) {
      expect(
        (
          schemas[schema] as {
            properties: Record<string, Record<string, unknown>>;
          }
        ).properties[field],
      ).toMatchObject({ type: 'string', enum: ['h12', 'h23'] });
    }
  });

  it(
    'crea sedes, filtra la agenda por X-Location-Id, deja la vista consolidada ' +
      'sin cabecera, rechaza una sede ajena y protege la última sede activa',
    async () => {
      const clinic = await registerAndLogin(app, {
        clinicName: 'Clinica Multi',
        subdomain: 'multi',
        email: 'owner@multi.com',
      });
      const host = hostFor(clinic.subdomain);
      const auth = (r: request.Test) =>
        r
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${clinic.accessToken}`);

      // --- 1. Al registrarse, la clínica ya nace con su "Sede principal".
      const initial = await auth(
        request(app.getHttpServer()).get('/api/v1/locations'),
      ).expect(200);
      const sedes = initial.body as LocationBody[];
      expect(sedes).toHaveLength(1);
      expect(sedes[0].name).toBe('Sede principal');
      const sedeA = sedes[0].id;

      // --- 2. Crear una segunda sede.
      const created = await auth(
        request(app.getHttpServer())
          .post('/api/v1/locations')
          .send(
            locationBody(REGIONAL_BOGOTA_FIXTURE, {
              name: 'Sede Norte',
              address: 'Cra 15',
            }),
          ),
      ).expect(201);
      const sedeB = (created.body as LocationBody).id;
      expect(sedeB).not.toBe(sedeA);

      // `registerAndLogin` dejó SIN horario la sede principal, pero la sede que
      // acabamos de crear nace con el suyo por defecto (lun-vie 9-13/15-19, sáb
      // 9-13, domingo cerrado). La cita del paso 3 va a la sede B con la
      // cabecera puesta, así que se valida contra ESE horario: sin este PUT la
      // suite falla cada vez que `now + 2 días` cae en domingo o fuera de esas
      // franjas. Este spec prueba el filtrado por sede, no el horario.
      await auth(
        request(app.getHttpServer())
          .put('/api/v1/locations/schedule')
          .set('X-Location-Id', sedeB)
          .send({ ranges: [] }),
      ).expect(200);

      // --- 3. Una cita creada CON la cabecera queda en esa sede.
      const patient = await auth(
        request(app.getHttpServer()).post('/api/v1/patients').send({
          firstName: 'Ana',
          lastName: 'Ruiz',
          docType: 'NATIONAL_ID',
          docNumber: '999',
          sex: 'F',
        }),
      ).expect(201);
      const patientId = (patient.body as { id: string }).id;

      const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      const staff = await auth(
        request(app.getHttpServer()).get('/api/v1/staff'),
      ).expect(200);
      const providerId = (staff.body as { userId: string }[])[0].userId;

      const appt = await auth(
        request(app.getHttpServer())
          .post('/api/v1/appointments')
          .set('X-Location-Id', sedeB)
          .send({
            patientId,
            providerId,
            start: start.toISOString(),
            end: end.toISOString(),
          }),
      ).expect(201);
      const apptId = (appt.body as AppointmentBody).id;

      const range = {
        from: new Date(start.getTime() - 60 * 60 * 1000).toISOString(),
        to: new Date(start.getTime() + 60 * 60 * 1000).toISOString(),
      };

      // --- 4. Filtrando por la sede B aparece...
      const inB = await auth(
        request(app.getHttpServer())
          .get('/api/v1/appointments')
          .set('X-Location-Id', sedeB)
          .query(range),
      ).expect(200);
      expect((inB.body as AppointmentBody[]).map((a) => a.id)).toContain(
        apptId,
      );

      // --- 5. ...y filtrando por la sede A NO. Esto es lo que prueba que el
      // filtro por sede realmente aplica y no es decorativo.
      const inA = await auth(
        request(app.getHttpServer())
          .get('/api/v1/appointments')
          .set('X-Location-Id', sedeA)
          .query(range),
      ).expect(200);
      expect((inA.body as AppointmentBody[]).map((a) => a.id)).not.toContain(
        apptId,
      );

      // --- 6. SIN cabecera se ve todo: la vista consolidada de la clínica es
      // el comportamiento por defecto (y el que tenían los clientes de antes).
      const consolidated = await auth(
        request(app.getHttpServer()).get('/api/v1/appointments').query(range),
      ).expect(200);
      expect(
        (consolidated.body as AppointmentBody[]).map((a) => a.id),
      ).toContain(apptId);

      // --- 7. Una sede que no es de esta clínica se rechaza, no se ignora.
      const otherClinic = await registerAndLogin(app, {
        clinicName: 'Otra Clinica',
        subdomain: 'otra-multi',
        email: 'owner@otra-multi.com',
      });
      const otherSedes = await request(app.getHttpServer())
        .get('/api/v1/locations')
        .set('X-Tenant-Host', hostFor(otherClinic.subdomain))
        .set('Authorization', `Bearer ${otherClinic.accessToken}`)
        .expect(200);
      const foreignSede = (otherSedes.body as LocationBody[])[0].id;

      await auth(
        request(app.getHttpServer())
          .get('/api/v1/appointments')
          .set('X-Location-Id', foreignSede)
          .query(range),
      ).expect(400);

      // --- 8. El DASHBOARD también respeta la sede, sin haber tocado nada:
      // compone los use-cases de citas/pagos/inventario, que ya filtran. Se
      // comprueba porque "emerge del diseño" no es lo mismo que "funciona".
      const dashQuery = {
        from: range.from.slice(0, 10),
        to: range.to.slice(0, 10),
        currency: 'USD',
      };
      const dashNorte = await auth(
        request(app.getHttpServer())
          .get('/api/v1/dashboard')
          .set('X-Location-Id', sedeB)
          .query(dashQuery),
      ).expect(200);
      const dashPrincipal = await auth(
        request(app.getHttpServer())
          .get('/api/v1/dashboard')
          .set('X-Location-Id', sedeA)
          .query(dashQuery),
      ).expect(200);

      type Dash = {
        upcomingAppointments: { id: string }[];
        patientCount: number;
      };
      const norte = dashNorte.body as Dash;
      const principal = dashPrincipal.body as Dash;

      expect(norte.upcomingAppointments.map((a) => a.id)).toContain(apptId);
      expect(principal.upcomingAppointments.map((a) => a.id)).not.toContain(
        apptId,
      );
      // ...pero el conteo de PACIENTES es igual en ambas: el paciente es de la
      // clínica, no de la sede (ficha centralizada).
      expect(principal.patientCount).toBe(norte.patientCount);

      // --- 9. No se puede desactivar la última sede activa: primero se
      // desactiva la B (quedan 1), y entonces la A ya no se puede desactivar.
      await auth(
        request(app.getHttpServer())
          .patch(`/api/v1/locations/${sedeB}`)
          .send({ isActive: false }),
      ).expect(200);

      await auth(
        request(app.getHttpServer())
          .patch(`/api/v1/locations/${sedeA}`)
          .send({ isActive: false }),
      ).expect(409);
    },
    30000,
  );

  it('PATCH del teléfono de la sede (DX-222): texto lo guarda, null lo quita, sin él no cambia', async () => {
    const clinic = await registerAndLogin(app, {
      clinicName: 'Clinica Telefono',
      subdomain: 'telefono-sede',
      email: 'owner@telefono-sede.com',
    });
    const host = hostFor(clinic.subdomain);
    const auth = (r: request.Test) =>
      r
        .set('X-Tenant-Host', host)
        .set('Authorization', `Bearer ${clinic.accessToken}`);
    const patch = (id: string, body: object) =>
      auth(request(app.getHttpServer()).patch(`/api/v1/locations/${id}`)).send(
        body,
      );

    const list = await auth(
      request(app.getHttpServer()).get('/api/v1/locations'),
    ).expect(200);
    const sede = (list.body as Array<LocationBody & { phone: unknown }>)[0];
    expect(sede.phone).toBeNull();

    const saved = await patch(sede.id, { phone: '601 555 0101' }).expect(200);
    expect((saved.body as { phone: unknown }).phone).toBe('601 555 0101');

    // Sin `phone` en el cuerpo: el teléfono no cambia.
    const renamed = await patch(sede.id, { name: 'Sede Centro' }).expect(200);
    expect(renamed.body).toMatchObject({
      name: 'Sede Centro',
      phone: '601 555 0101',
    });

    // `null` (lo que envía la web al vaciar el campo) lo quita.
    const cleared = await patch(sede.id, { phone: null }).expect(200);
    expect((cleared.body as { phone: unknown }).phone).toBeNull();
    const row = await raw.location.findUniqueOrThrow({
      where: { id: sede.id },
    });
    expect(row.phone).toBeNull();

    const tooLong = await patch(sede.id, { phone: '1'.repeat(41) }).expect(400);
    expect(JSON.stringify(tooLong.body)).toContain(
      'El teléfono admite hasta 40 caracteres.',
    );
    await patch(sede.id, { phone: 601 }).expect(400);
  });

  describe('alta de sede con moneda, zona y formato (G1, spec §3.1)', () => {
    let auth: (r: request.Test) => request.Test;
    let tenantId: string;
    const post = (body: object) =>
      auth(request(app.getHttpServer()).post('/api/v1/locations')).send(body);

    beforeAll(async () => {
      const clinic = await registerAndLogin(app, {
        clinicName: 'Clinica Regional',
        subdomain: 'regional-sede',
        email: 'owner@regional-sede.com',
      });
      tenantId = clinic.tenantId;
      const host = hostFor(clinic.subdomain);
      auth = (r) =>
        r
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${clinic.accessToken}`);
    });

    it.each([
      ['country', 'Elige el país de la sede.'],
      ['currency', 'Elige la moneda de la sede.'],
      ['timeZone', 'Elige la zona horaria de la sede.'],
      ['locale', 'Elige el formato regional de la sede.'],
    ])(
      'POST /locations without each regional field is 400 (%s)',
      async (field, message) => {
        const body: Record<string, unknown> = {
          ...locationBody(REGIONAL_TOKYO_FIXTURE, { name: `Sin ${field}` }),
        };
        delete body[field];
        const res = await post(body).expect(400);
        expect(res.body).toMatchObject({ message, field });
        expect(
          await raw.location.count({
            where: { tenantId, name: `Sin ${field}` },
          }),
        ).toBe(0);
      },
    );

    it('moneda que no está en la lista, zona inexistente y formato inválido: 400 con su mensaje', async () => {
      const cases: [object, string, string][] = [
        [
          { currency: 'XYZ' },
          'currency',
          'La moneda XYZ no está en la lista de monedas admitidas.',
        ],
        [
          { timeZone: 'Mars/Olympus' },
          'timeZone',
          'La zona horaria «Mars/Olympus» no existe.',
        ],
        [
          { locale: 'not a locale' },
          'locale',
          'El formato regional «not a locale» no es válido.',
        ],
      ];
      for (const [patch, field, message] of cases) {
        const res = await post(
          locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Mala', ...patch }),
        ).expect(400);
        expect(res.body).toMatchObject({ message, field });
      }
    });

    it('POST /locations JPY/Asia/Tokyo/ja-JP is 201 and reviewed', async () => {
      const before = Date.now();
      const res = await post(
        locationBody(REGIONAL_TOKYO_FIXTURE, {
          name: 'Tokio',
          currency: 'jpy',
          locale: 'JA-jp',
        }),
      ).expect(201);
      expect(res.body).toMatchObject({
        name: 'Tokio',
        country: 'JP',
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
      });
      const reviewedAt = (res.body as { regionalSettingsReviewedAt: string })
        .regionalSettingsReviewedAt;
      expect(new Date(reviewedAt).getTime()).toBeGreaterThanOrEqual(
        before - 1000,
      );
      const row = await raw.location.findUniqueOrThrow({
        where: { id: (res.body as { id: string }).id },
      });
      expect(row).toMatchObject({
        currency: 'JPY',
        timeZone: 'Asia/Tokyo',
        locale: 'ja-JP',
      });
      expect(row.regionalSettingsReviewedAt).not.toBeNull();
    });

    it('GET /locations returns null regional fields for an old-replica row, never country values', async () => {
      const legacyId = await legacyLocationInsert(
        raw,
        tenantId,
        'Antigua',
        REGIONAL_BOGOTA_FIXTURE.country,
      );
      const res = await auth(
        request(app.getHttpServer()).get('/api/v1/locations'),
      ).expect(200);
      const legacy = (res.body as Array<Record<string, unknown>>).find(
        (l) => l.id === legacyId,
      );
      expect(legacy).toMatchObject({
        country: 'CO',
        currency: null,
        timeZone: null,
        locale: null,
        hourCycle: null,
        regionalSettingsReviewedAt: null,
      });
    });

    it('POST /locations with h12 stores it reviewed', async () => {
      const res = await post(
        locationBody(REGIONAL_NEW_YORK_FIXTURE, { name: 'Nueva York' }),
      ).expect(201);
      const body = res.body as {
        id: string;
        hourCycle: string;
        regionalSettingsReviewedAt: string | null;
      };
      expect(body).toMatchObject({ locale: 'en-US', hourCycle: 'h12' });
      expect(body.regionalSettingsReviewedAt).not.toBeNull();
      const row = await raw.location.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.hourCycle).toBe('h12');
      expect(row.regionalSettingsReviewedAt).not.toBeNull();
    });

    it('POST /locations from the G1 web without hourCycle is 201 with the backfilled clock', async () => {
      // La web de G1 envía moneda, zona y formato pero no el reloj (fase 1,
      // spec §4.1): la API como dentalix_app llama a la función de backfill en
      // la misma transacción (pre-flight I1, por el endpoint real).
      // Una hermana sin reloj (réplica de G1 sin barrer): la función es de
      // todo el tenant, así que también la rellena, sin marcarla revisada.
      const sibling = await g1LocationInsert(
        raw,
        tenantId,
        'Hermana G1 sin reloj',
        REGIONAL_TOKYO_FIXTURE,
      );
      const body: Record<string, unknown> = {
        ...locationBody(REGIONAL_BERLIN_FIXTURE, { name: 'Web G1' }),
      };
      delete body.hourCycle;
      const res = await post(body).expect(201);
      const created = res.body as {
        id: string;
        hourCycle: string | null;
        regionalSettingsReviewedAt: string | null;
      };
      expect(created).toMatchObject({
        currency: 'EUR',
        timeZone: 'Europe/Berlin',
        locale: 'de-DE',
        hourCycle: 'h23',
      });
      expect(created.regionalSettingsReviewedAt).not.toBeNull();
      const row = await raw.location.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.hourCycle).toBe('h23');
      const siblingRow = await raw.location.findUniqueOrThrow({
        where: { id: sibling },
      });
      expect(siblingRow.hourCycle).toBe('h23');
      expect(siblingRow.regionalSettingsReviewedAt).toBeNull();
    });

    it('hourCycle h24 is 400', async () => {
      for (const [hourCycle, message] of [
        ['h24', 'El reloj «h24» no es válido: elige 12 h o 24 h.'],
        ['', 'Elige el reloj de la sede: 12 h o 24 h.'],
      ]) {
        const res = await post(
          locationBody(REGIONAL_NEW_YORK_FIXTURE, {
            name: 'Reloj malo',
            hourCycle,
          }),
        ).expect(400);
        expect(res.body).toMatchObject({ message, field: 'hourCycle' });
      }
      // El reloj se valida después del formato (moneda, zona, formato, reloj).
      const order = await post(
        locationBody(REGIONAL_NEW_YORK_FIXTURE, {
          name: 'Reloj malo',
          locale: 'not a locale',
          hourCycle: 'h24',
        }),
      ).expect(400);
      expect(order.body).toMatchObject({ field: 'locale' });
      expect(
        await raw.location.count({ where: { tenantId, name: 'Reloj malo' } }),
      ).toBe(0);
    });

    it('GET /locations returns hourCycle', async () => {
      const tokyo = await post(
        locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'Lista 24 h' }),
      ).expect(201);
      const newYork = await post(
        locationBody(REGIONAL_NEW_YORK_FIXTURE, { name: 'Lista 12 h' }),
      ).expect(201);
      // Una sede de una réplica de G1 aún sin barrer: reloj null, nunca otro.
      const g1Id = await g1LocationInsert(
        raw,
        tenantId,
        'Réplica G1',
        REGIONAL_BERLIN_FIXTURE,
      );
      const res = await auth(
        request(app.getHttpServer()).get('/api/v1/locations'),
      ).expect(200);
      const byId = new Map(
        (res.body as Array<{ id: string; hourCycle: string | null }>).map(
          (l) => [l.id, l.hourCycle],
        ),
      );
      expect(byId.get((tokyo.body as { id: string }).id)).toBe('h23');
      expect(byId.get((newYork.body as { id: string }).id)).toBe('h12');
      expect(byId.get(g1Id)).toBeNull();
    });

    it('DENTIST no puede crear sedes (403)', async () => {
      const dentist = await raw.user.create({
        data: {
          email: 'dentist@regional-sede.com',
          passwordHash: (
            await raw.user.findFirstOrThrow({
              where: { email: 'owner@regional-sede.com' },
              select: { passwordHash: true },
            })
          ).passwordHash,
          fullName: 'Dra. Dentista',
          emailVerifiedAt: new Date(),
        },
        select: { id: true },
      });
      await raw.clinicMembership.create({
        data: { tenantId, userId: dentist.id, role: 'DENTIST' },
      });
      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('X-Tenant-Host', hostFor('regional-sede'))
        .send({ email: 'dentist@regional-sede.com', password: PASSWORD })
        .expect(201);
      await request(app.getHttpServer())
        .post('/api/v1/locations')
        .set('X-Tenant-Host', hostFor('regional-sede'))
        .set('Authorization', `Bearer ${(login.body as LoginBody).accessToken}`)
        .send(locationBody(REGIONAL_TOKYO_FIXTURE, { name: 'No' }))
        .expect(403);
    });
  });

  describe('prefijo telefónico de la sede (DX-329)', () => {
    let auth: (r: request.Test) => request.Test;
    let tenantId: string;
    const post = (body: object) =>
      auth(request(app.getHttpServer()).post('/api/v1/locations')).send(body);
    const patch = (id: string, body: object) =>
      auth(request(app.getHttpServer()).patch(`/api/v1/locations/${id}`)).send(
        body,
      );
    const row = (id: string) =>
      raw.location.findUniqueOrThrow({ where: { id } });
    /** El cuerpo de alta SIN región: `locationBody` la manda y la sugerencia no se vería. */
    const withoutRegion = (name: string, country: string) => {
      const { defaultPhoneRegion: _omit, ...rest } = locationBody(
        REGIONAL_TOKYO_FIXTURE,
        { name, country },
      );
      void _omit;
      return rest;
    };
    const idOf = (res: request.Response) => (res.body as { id: string }).id;

    beforeAll(async () => {
      const clinic = await registerAndLogin(app, {
        clinicName: 'Clinica Prefijo',
        subdomain: 'prefijo-sede',
        email: 'owner@prefijo-sede.com',
      });
      tenantId = clinic.tenantId;
      const host = hostFor(clinic.subdomain);
      auth = (r) =>
        r
          .set('X-Tenant-Host', host)
          .set('Authorization', `Bearer ${clinic.accessToken}`);
    });

    it('POST /locations without defaultPhoneRegion suggests the country', async () => {
      const res = await post(withoutRegion('Sugerida', 'VE')).expect(201);
      expect(res.body).toMatchObject({ defaultPhoneRegion: 'VE' });
      expect((await row(idOf(res))).defaultPhoneRegionSetAt).toBeInstanceOf(
        Date,
      );
    });

    it('POST /locations with defaultPhoneRegion null stores none', async () => {
      const res = await post({
        ...withoutRegion('Sin prefijo', 'VE'),
        defaultPhoneRegion: null,
      }).expect(201);
      expect(
        (res.body as { defaultPhoneRegion: unknown }).defaultPhoneRegion,
      ).toBeNull();
      // La marca distingue «nadie decidió» de «sin prefijo, a propósito».
      expect((await row(idOf(res))).defaultPhoneRegionSetAt).toBeInstanceOf(
        Date,
      );
    });

    it('POST /locations with another region stores it', async () => {
      const res = await post({
        ...withoutRegion('Otra región', 'VE'),
        defaultPhoneRegion: ' co ',
      }).expect(201);
      expect(res.body).toMatchObject({
        country: 'VE',
        defaultPhoneRegion: 'CO',
      });
    });

    it('POST /locations in a country without phone metadata stores none', async () => {
      const res = await post(withoutRegion('Antártida', 'AQ')).expect(201);
      const stored = await row(idOf(res));
      expect(stored.defaultPhoneRegion).toBeNull();
      expect(stored.defaultPhoneRegionSetAt).toBeInstanceOf(Date);
    });

    it('PATCH /locations/:id changing the country keeps the default phone region', async () => {
      const id = idOf(
        await post(withoutRegion('Cambia país', 'VE')).expect(201),
      );
      const before = await row(id);
      const res = await patch(id, { country: 'JP' }).expect(200);
      expect(res.body).toMatchObject({
        country: 'JP',
        defaultPhoneRegion: 'VE',
      });
      expect((await row(id)).defaultPhoneRegionSetAt).toEqual(
        before.defaultPhoneRegionSetAt,
      );
    });

    it('PATCH /locations/:id with an unknown region is 400 with field defaultPhoneRegion', async () => {
      const id = idOf(
        await post(withoutRegion('Región mala', 'VE')).expect(201),
      );
      const unknown = await patch(id, { defaultPhoneRegion: 'AQ' }).expect(400);
      expect(unknown.body).toMatchObject({
        field: 'defaultPhoneRegion',
        message: 'El prefijo telefónico «AQ» no está en la lista.',
      });
      const text = await patch(id, {
        defaultPhoneRegion: 'x'.repeat(300),
      }).expect(400);
      expect(text.body).toMatchObject({
        field: 'defaultPhoneRegion',
        message: 'El prefijo telefónico indicado no está en la lista.',
      });
      // Lo que no es texto: el mismo 400 con `field`, no el de la
      // ValidationPipe (M9 de la revisión final).
      for (const value of [58, true, { code: 'VE' }, ['VE']]) {
        const notText = await patch(id, { defaultPhoneRegion: value }).expect(
          400,
        );
        expect(notText.body).toMatchObject({
          field: 'defaultPhoneRegion',
          message: 'El prefijo telefónico indicado no está en la lista.',
        });
      }
      expect((await row(id)).defaultPhoneRegion).toBe('VE');
    });

    it('POST /locations with a defaultPhoneRegion that is not text is 400 with field', async () => {
      const res = await post({
        ...withoutRegion('Región numérica', 'VE'),
        defaultPhoneRegion: 58,
      }).expect(400);
      expect(res.body).toMatchObject({
        field: 'defaultPhoneRegion',
        message: 'El prefijo telefónico indicado no está en la lista.',
      });
    });

    it('PATCH /locations/:id with defaultPhoneRegion null clears it and does not mark the regional settings as reviewed', async () => {
      const id = idOf(await post(withoutRegion('Se vacía', 'VE')).expect(201));
      // Una sede por revisar: lo regional sigue sin confirmar.
      await raw.location.update({
        where: { id },
        data: { regionalSettingsReviewedAt: null },
      });
      const res = await patch(id, { defaultPhoneRegion: null }).expect(200);
      expect(
        (res.body as { defaultPhoneRegion: unknown }).defaultPhoneRegion,
      ).toBeNull();
      expect((await row(id)).regionalSettingsReviewedAt).toBeNull();
      const empty = await patch(id, { defaultPhoneRegion: 'co' }).expect(200);
      expect(empty.body).toMatchObject({ defaultPhoneRegion: 'CO' });
      expect((await row(id)).regionalSettingsReviewedAt).toBeNull();
      await patch(id, { defaultPhoneRegion: '' }).expect(200);
      expect((await row(id)).defaultPhoneRegion).toBeNull();
    });

    it('the PATCH audit lists defaultPhoneRegion among the changed fields without values', async () => {
      const id = idOf(await post(withoutRegion('Auditada', 'VE')).expect(201));
      await patch(id, { defaultPhoneRegion: 'CO' }).expect(200);
      const events = await raw.auditEvent.findMany({
        where: { tenantId, action: 'UPDATE', resourceId: id },
      });
      expect(events).toHaveLength(1);
      expect(events[0].metadata).toEqual({
        changedFields: ['defaultPhoneRegion'],
        params: { id },
      });
    });

    it('creating and editing with the field set the decision mark; editing without it leaves the mark alone', async () => {
      const id = idOf(await post(withoutRegion('Marca', 'VE')).expect(201));
      const created = (await row(id)).defaultPhoneRegionSetAt;
      expect(created).toBeInstanceOf(Date);
      await patch(id, { name: 'Marca renombrada' }).expect(200);
      expect((await row(id)).defaultPhoneRegionSetAt).toEqual(created);
      await new Promise((resolve) => setTimeout(resolve, 20));
      await patch(id, { defaultPhoneRegion: 'CO' }).expect(200);
      const edited = (await row(id)).defaultPhoneRegionSetAt!;
      expect(edited.getTime()).toBeGreaterThan(created!.getTime());
      await new Promise((resolve) => setTimeout(resolve, 20));
      await patch(id, { defaultPhoneRegion: null }).expect(200);
      expect(
        (await row(id)).defaultPhoneRegionSetAt!.getTime(),
      ).toBeGreaterThan(edited.getTime());
    });
  });
});
