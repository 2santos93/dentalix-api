import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { ClinicRole, Prisma, PrismaClient } from '@prisma/client';
import { PrismaService } from '../src/shared/prisma/prisma.service';
import { TenantContextService } from '../src/shared/tenancy/tenant-context.service';
import type { AuditRequestContext } from '../src/modules/audit/domain/audit-request-context';
import { LeadsUseCases } from '../src/modules/leads/application/leads.use-cases';
import { PrismaLeadRepository } from '../src/modules/leads/infrastructure/prisma-lead.repository';
import { PrismaLeadRetentionRepository } from '../src/modules/leads/infrastructure/prisma-lead-retention.repository';
import {
  leadsOnAppointmentCompletedInTx,
  leadsOnAppointmentCreatedInTx,
} from '../src/modules/leads/infrastructure/lead-from-appointment';
import {
  REGIONAL_CARACAS_FIXTURE,
  locationData,
} from './support/location-fixtures';
import { purgeTenantsBySubdomain } from './support/tenant-purge';
import { settle } from './support/postgres-concurrency';

// DX-556 · Prospectos con el caso de uso y los repositorios REALES sobre
// Postgres como dentalix_app (RLS FORCE). `raw` (DIRECT_URL, owner) siembra,
// comprueba y limpia. Sedes en Caracas, teléfonos +58. Los relojes son los de
// la BD: para «hace más de 24 h» y la retención se mueven las fechas en la
// BD (con los disparadores apagados solo en esa sentencia).
const raw = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});
const tenantContext = new TenantContextService();
const prisma = new PrismaService(tenantContext);
const repo = new PrismaLeadRepository(prisma, tenantContext);
const leads = new LeadsUseCases(repo, tenantContext);
const retention = new PrismaLeadRetentionRepository(prisma);

const SUBDOMAIN = 'dx556-prospectos';
const OTHER_SUBDOMAIN = 'dx556-prospectos-b';

interface Seeded {
  tenantId: string;
  adminId: string;
  receptionId: string;
  dentistId: string;
  chacao: string;
  norte: string;
  otherTenantId: string;
  otherAdminId: string;
  otherSede: string;
}
let s: Seeded;
let phoneSeq = 0;
/** Un móvil venezolano distinto por prospecto (+58 412 …). */
const nextPhone = () => `0412 55${String(10000 + ++phoneSeq).slice(-5)}`;
const e164Of = (national: string) =>
  `+58${national.replace(/\D/g, '').slice(1)}`;

const audit = (
  tenantId = s.tenantId,
  userId = s.receptionId,
  role: ClinicRole = ClinicRole.RECEPTION,
): AuditRequestContext => ({
  tenantId,
  locationId: null,
  actor: { userId, role },
  requestId: 'dx556-int',
  ip: null,
  userAgent: null,
});
/** Contexto de clínica: sin sede activa y, si se pide, restringido a sedes. */
const asA = <T>(fn: () => Promise<T>, allowed?: string[]) =>
  tenantContext.run(s.tenantId, undefined, fn, allowed);
const asB = <T>(fn: () => Promise<T>) =>
  tenantContext.run(s.otherTenantId, undefined, fn);

async function create(
  over: Partial<Parameters<LeadsUseCases['create']>[0]> = {},
) {
  return asA(() =>
    leads.create(
      {
        fullName: 'Rosa Medina',
        phone: nextPhone(),
        channel: 'WHATSAPP',
        locationId: s.chacao,
        ...over,
      },
      audit(),
    ),
  );
}

/** Mueve fechas en la BD sin pasar por los disparadores (solo en el test). */
async function backdate(id: string, column: string, hours: number) {
  await raw.$transaction([
    raw.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`),
    raw.$executeRawUnsafe(
      `UPDATE "leads" SET "${column}" = timezone('UTC', now()) - ($1::int * interval '1 hour') WHERE "id" = $2::uuid`,
      hours,
      id,
    ),
  ]);
}

async function seed(): Promise<Seeded> {
  const tenant = await raw.tenant.create({
    data: { name: SUBDOMAIN, subdomain: SUBDOMAIN },
  });
  const other = await raw.tenant.create({
    data: { name: OTHER_SUBDOMAIN, subdomain: OTHER_SUBDOMAIN },
  });
  const user = (email: string, fullName: string) =>
    raw.user.create({
      data: {
        email: `${email}@${SUBDOMAIN}.test`,
        passwordHash: 'x',
        fullName,
      },
    });
  const admin = await user('admin', 'Andreína Torres');
  const reception = await user('recepcion', 'Yusmary Pérez');
  const dentist = await user('odontologo', 'Dr. Luis Méndez');
  const otherAdmin = await user('admin-b', 'Gabriel Rondón');
  await raw.clinicMembership.createMany({
    data: [
      { tenantId: tenant.id, userId: admin.id, role: ClinicRole.ADMIN },
      { tenantId: tenant.id, userId: reception.id, role: ClinicRole.RECEPTION },
      { tenantId: tenant.id, userId: dentist.id, role: ClinicRole.DENTIST },
      { tenantId: other.id, userId: otherAdmin.id, role: ClinicRole.ADMIN },
    ],
  });
  const chacao = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Chacao',
    }),
  });
  const norte = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: tenant.id,
      name: 'Sede Norte',
    }),
  });
  const otherSede = await raw.location.create({
    data: locationData(REGIONAL_CARACAS_FIXTURE, {
      tenantId: other.id,
      name: 'Sede Maracaibo',
    }),
  });
  return {
    tenantId: tenant.id,
    adminId: admin.id,
    receptionId: reception.id,
    dentistId: dentist.id,
    chacao: chacao.id,
    norte: norte.id,
    otherTenantId: other.id,
    otherAdminId: otherAdmin.id,
    otherSede: otherSede.id,
  };
}

async function leadEvents(leadId: string) {
  return raw.auditEvent.findMany({
    where: { resourceType: 'LEAD', resourceId: leadId },
    orderBy: { occurredAt: 'asc' },
    select: {
      action: true,
      actorUserId: true,
      patientId: true,
      metadata: true,
    },
  });
}

describe('DX-556 · prospectos sobre Postgres (RLS FORCE)', () => {
  beforeAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN, OTHER_SUBDOMAIN]);
    await raw.user.deleteMany({
      where: { email: { endsWith: `@${SUBDOMAIN}.test` } },
    });
    s = await seed();
  });

  afterAll(async () => {
    await purgeTenantsBySubdomain(raw, [SUBDOMAIN, OTHER_SUBDOMAIN]);
    await raw.user.deleteMany({
      where: { email: { endsWith: `@${SUBDOMAIN}.test` } },
    });
    await raw.$disconnect();
    await prisma.$disconnect();
  });

  describe('alta y teléfono repetido', () => {
    it('nace en NEW con el teléfono en E.164, responsable = quien lo crea y su evento CREATE sin datos personales', async () => {
      const phone = nextPhone();
      const lead = await create({ phone, interestReason: 'ortodoncia' });
      expect(lead).toMatchObject({
        stage: 'NEW',
        fullName: 'Rosa Medina',
        whatsAppDigits: e164Of(phone).slice(1),
        interestReason: 'Ortodoncia',
        ownerId: s.receptionId,
        locationId: s.chacao,
        stale: false,
      });
      const events = await leadEvents(lead.id);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'CREATE',
          actorUserId: s.receptionId,
          patientId: null,
          metadata: { reason: 'LEAD_CREATED' },
        }),
      ]);
      expect(JSON.stringify(events)).not.toContain('Rosa');
    });

    it('el teléfono de otro prospecto (escrito distinto) da 409 LEAD con su id', async () => {
      const phone = nextPhone();
      const first = await create({ phone });
      const again = await settle(
        create({ phone: `+58 ${phone.slice(1)}`, fullName: 'Otra persona' }),
      );
      expect(again.status).toBe('rejected');
      const error = (again as { reason: ConflictException }).reason;
      expect(error).toBeInstanceOf(ConflictException);
      expect(error.getResponse()).toMatchObject({
        code: 'LEAD_PHONE_TAKEN',
        existing: { kind: 'LEAD', id: first.id, name: 'Rosa Medina' },
      });
    });

    it('el teléfono de un paciente vivo da 409 PATIENT y no crea nada', async () => {
      const phone = nextPhone();
      const patient = await raw.patient.create({
        data: {
          tenantId: s.tenantId,
          firstName: 'Carlos',
          lastName: 'Briceño',
          phone,
          phoneE164: e164Of(phone),
        },
      });
      await expect(create({ phone })).rejects.toMatchObject({
        response: {
          code: 'LEAD_PHONE_TAKEN',
          existing: { kind: 'PATIENT', id: patient.id, name: 'Carlos Briceño' },
        },
      });
      expect(
        await raw.lead.count({ where: { phoneE164: e164Of(phone) } }),
      ).toBe(0);
    });

    it('del prospecto de una sede no permitida no dice cuál', async () => {
      const phone = nextPhone();
      await create({ phone, locationId: s.norte });
      await expect(
        asA(
          () =>
            leads.create(
              { fullName: 'X', phone, channel: 'PHONE', locationId: s.chacao },
              audit(),
            ),
          [s.chacao],
        ),
      ).rejects.toMatchObject({
        response: { existing: { kind: 'LEAD', id: null, name: null } },
      });
    });

    it('dos altas a la vez con el mismo número: una sola fila (único parcial) y la otra 409', async () => {
      const phone = nextPhone();
      const results = await Promise.all([
        settle(create({ phone, fullName: 'Primera' })),
        settle(create({ phone, fullName: 'Segunda' })),
        settle(create({ phone, fullName: 'Tercera' })),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected')) {
        expect((r as { reason: unknown }).reason).toBeInstanceOf(
          ConflictException,
        );
      }
      expect(
        await raw.lead.count({ where: { phoneE164: e164Of(phone) } }),
      ).toBe(1);
    });

    it('teléfono no válido, motivo fuera del catálogo o responsable no válido: 400', async () => {
      await expect(create({ phone: '123' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        create({ interestReason: 'Algo inventado' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Un odontólogo no lleva prospectos; un usuario de otra clínica tampoco.
      await expect(create({ ownerId: s.dentistId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(create({ ownerId: s.otherAdminId })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('etapas', () => {
    it('«Perdido» exige un motivo del catálogo; con él guarda la foto del texto y la fecha', async () => {
      const lead = await create();
      await expect(
        asA(() => leads.changeStage(lead.id, { stage: 'LOST' }, audit())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        asA(() =>
          leads.changeStage(
            lead.id,
            { stage: 'LOST', lostReason: 'Me cae mal' },
            audit(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      const lost = await asA(() =>
        leads.changeStage(
          lead.id,
          { stage: 'LOST', lostReason: 'precio' },
          audit(),
        ),
      );
      expect(lost).toMatchObject({ stage: 'LOST', lostReason: 'Precio' });
      expect(lost.lostAt).toBeInstanceOf(Date);
      // Reabrir borra el motivo y la fecha.
      const reopened = await asA(() =>
        leads.changeStage(lead.id, { stage: 'CONTACTED' }, audit()),
      );
      expect(reopened).toMatchObject({
        stage: 'CONTACTED',
        lostReason: null,
        lostAt: null,
      });
      const events = await leadEvents(lead.id);
      expect(events.map((e) => e.metadata)).toEqual([
        { reason: 'LEAD_CREATED' },
        {
          reason: 'LEAD_STAGE_CHANGED',
          statusChange: { from: 'NEW', to: 'LOST' },
        },
        {
          reason: 'LEAD_STAGE_CHANGED',
          statusChange: { from: 'LOST', to: 'CONTACTED' },
        },
      ]);
    });

    it('un motivo propio de la clínica también vale; uno retirado ya no', async () => {
      const reason = await asA(() =>
        leads.createReason('LOSS', 'Se mudó a Valencia', s.adminId),
      );
      const lead = await create();
      await expect(
        asA(() =>
          leads.changeStage(
            lead.id,
            { stage: 'LOST', lostReason: 'Se mudó a Valencia' },
            audit(),
          ),
        ),
      ).resolves.toMatchObject({ lostReason: 'Se mudó a Valencia' });
      await asA(() => leads.deleteReason(reason.id));
      const other = await create();
      await expect(
        asA(() =>
          leads.changeStage(
            other.id,
            { stage: 'LOST', lostReason: 'Se mudó a Valencia' },
            audit(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('la BD rechaza LOST sin motivo aunque la app se equivoque (CHECK)', async () => {
      const lead = await create();
      await expect(
        raw.$executeRaw`UPDATE "leads" SET "stage" = 'LOST' WHERE "id" = ${lead.id}::uuid`,
      ).rejects.toThrow(/leads_stage_check/);
    });

    it('«Cita agendada» y «Asistió» no se ponen a mano (409)', async () => {
      const lead = await create();
      for (const stage of ['SCHEDULED', 'ATTENDED'] as const) {
        await expect(
          asA(() => leads.changeStage(lead.id, { stage }, audit())),
        ).rejects.toBeInstanceOf(ConflictException);
      }
    });
  });

  describe('conversión en paciente', () => {
    it('crea la ficha mínima (sin datos clínicos), copia nombre y teléfono y deja el vínculo; dos veces = el mismo paciente', async () => {
      const phone = nextPhone();
      const lead = await create({
        phone,
        fullName: 'María del Carmen Rondón',
      });
      const first = await asA(() => leads.convert(lead.id, {}, audit()));
      expect(first).toMatchObject({ created: true, linked: false });
      const patient = await raw.patient.findUniqueOrThrow({
        where: { id: first.patientId },
      });
      expect(patient).toMatchObject({
        tenantId: s.tenantId,
        firstName: 'María',
        lastName: 'del Carmen Rondón',
        phoneE164: e164Of(phone),
        documentType: 'OTHER',
        sex: 'UNSPECIFIED',
        createdById: s.receptionId,
      });
      expect(
        await raw.medicalHistoryVersion.count({
          where: { patientId: patient.id },
        }),
      ).toBe(0);
      expect(first.lead).toMatchObject({
        convertedPatientId: patient.id,
        stage: 'NEW',
      });
      const second = await asA(() => leads.convert(lead.id, {}, audit()));
      expect(second).toMatchObject({
        patientId: patient.id,
        created: false,
        linked: false,
      });
      expect(
        await raw.patient.count({ where: { phoneE164: e164Of(phone) } }),
      ).toBe(1);
      const created = await raw.auditEvent.findMany({
        where: {
          resourceType: 'PATIENT',
          resourceId: patient.id,
          action: 'CREATE',
        },
        select: { patientId: true, metadata: true },
      });
      expect(created).toEqual([
        {
          patientId: patient.id,
          metadata: { reason: 'LEAD_CONVERTED', params: { leadId: lead.id } },
        },
      ]);
    });

    it('bajo concurrencia (5 a la vez) crea UN paciente y todos devuelven el mismo', async () => {
      const phone = nextPhone();
      const lead = await create({ phone, fullName: 'Pedro Salazar' });
      const results = await Promise.all(
        Array.from({ length: 5 }, () =>
          settle(asA(() => leads.convert(lead.id, {}, audit()))),
        ),
      );
      expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
      const ids = new Set(
        results.map(
          (r) => (r as { value: { patientId: string } }).value.patientId,
        ),
      );
      expect(ids.size).toBe(1);
      expect(
        results.filter(
          (r) => (r as { value: { created: boolean } }).value.created,
        ),
      ).toHaveLength(1);
      expect(
        await raw.patient.count({ where: { phoneE164: e164Of(phone) } }),
      ).toBe(1);
      const linked = await raw.lead.findUniqueOrThrow({
        where: { id: lead.id },
      });
      expect(linked.convertedPatientId).toBe([...ids][0]);
    });

    it('si el teléfono ya es de un paciente lo enlaza; con varios, 409 con candidatos y se elige', async () => {
      const phone = nextPhone();
      const lead = await create({ phone, fullName: 'Luisa Herrera' });
      const data = (firstName: string) => ({
        tenantId: s.tenantId,
        firstName,
        lastName: 'Herrera',
        phone,
        phoneE164: e164Of(phone),
      });
      const mother = await raw.patient.create({ data: data('Luisa') });
      const daughter = await raw.patient.create({ data: data('Ana') });
      await expect(
        asA(() => leads.convert(lead.id, {}, audit())),
      ).rejects.toMatchObject({
        response: {
          code: 'LEAD_AMBIGUOUS_PATIENTS',
          candidates: [
            { id: mother.id, name: 'Luisa Herrera' },
            { id: daughter.id, name: 'Ana Herrera' },
          ],
        },
      });
      // Un paciente que no es candidato (otro número) no vale.
      const stranger = await raw.patient.create({
        data: { tenantId: s.tenantId, firstName: 'Otro', lastName: 'Más' },
      });
      await expect(
        asA(() => leads.convert(lead.id, { patientId: stranger.id }, audit())),
      ).rejects.toBeInstanceOf(BadRequestException);
      const linked = await asA(() =>
        leads.convert(lead.id, { patientId: mother.id }, audit()),
      );
      expect(linked).toMatchObject({
        patientId: mother.id,
        created: false,
        linked: true,
      });
      const events = await leadEvents(lead.id);
      expect(events.at(-1)).toMatchObject({
        patientId: mother.id,
        metadata: { reason: 'LEAD_LINKED' },
      });
    });

    it('con una sola palabra pide el apellido (400) y lo acepta en el cuerpo', async () => {
      const lead = await create({ fullName: 'Yorman' });
      await expect(
        asA(() => leads.convert(lead.id, {}, audit())),
      ).rejects.toBeInstanceOf(BadRequestException);
      await expect(
        asA(() => leads.convert(lead.id, { lastName: 'Ochoa' }, audit())),
      ).resolves.toMatchObject({ created: true });
    });

    it('la BD no deja cambiar el paciente enlazado (guarda)', async () => {
      const lead = await create({ fullName: 'Elena Castillo' });
      await asA(() => leads.convert(lead.id, {}, audit()));
      const other = await raw.patient.create({
        data: { tenantId: s.tenantId, firstName: 'X', lastName: 'Y' },
      });
      await expect(
        raw.$executeRaw`UPDATE "leads" SET "patientId" = ${other.id}::uuid WHERE "id" = ${lead.id}::uuid`,
      ).rejects.toThrow(/se fija una vez/);
    });
  });

  describe('la cita mueve al prospecto', () => {
    it('cita creada → SCHEDULED (primera cita fija); atendida → ATTENDED, con su evento', async () => {
      const lead = await create({ fullName: 'Ramón Guerra' });
      const { patientId } = await asA(() =>
        leads.convert(lead.id, {}, audit()),
      );
      const appointment = (start: string) =>
        raw.appointment.create({
          data: {
            tenantId: s.tenantId,
            locationId: s.chacao,
            patientId,
            providerId: s.dentistId,
            start: new Date(start),
            end: new Date(new Date(start).getTime() + 30 * 60_000),
          },
        });
      const first = await appointment('2027-03-01T14:00:00Z');
      const ctx = {
        ...audit(),
        actor: { userId: s.receptionId, role: ClinicRole.RECEPTION },
      };
      await prisma.runWithTenant(s.tenantId, (tx) =>
        leadsOnAppointmentCreatedInTx(tx, {
          tenantId: s.tenantId,
          patientId,
          appointmentId: first.id,
          actor: ctx,
        }),
      );
      let row = await raw.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(row).toMatchObject({
        stage: 'SCHEDULED',
        firstAppointmentId: first.id,
      });
      expect(row.scheduledAt).toBeInstanceOf(Date);
      // Una segunda cita no cambia la primera ni vuelve a mover.
      const second = await appointment('2027-03-08T14:00:00Z');
      await expect(
        prisma.runWithTenant(s.tenantId, (tx) =>
          leadsOnAppointmentCreatedInTx(tx, {
            tenantId: s.tenantId,
            patientId,
            appointmentId: second.id,
            actor: ctx,
          }),
        ),
      ).resolves.toBe(0);
      // Sin usuario (reserva online) no se mueve nada.
      await expect(
        prisma.runWithTenant(s.tenantId, (tx) =>
          leadsOnAppointmentCompletedInTx(tx, {
            tenantId: s.tenantId,
            patientId,
            appointmentId: first.id,
            actor: null,
          }),
        ),
      ).resolves.toBe(0);
      await prisma.runWithTenant(s.tenantId, (tx) =>
        leadsOnAppointmentCompletedInTx(tx, {
          tenantId: s.tenantId,
          patientId,
          appointmentId: first.id,
          actor: ctx,
        }),
      );
      row = await raw.lead.findUniqueOrThrow({ where: { id: lead.id } });
      expect(row).toMatchObject({
        stage: 'ATTENDED',
        firstAppointmentId: first.id,
      });
      expect(row.attendedAt).toBeInstanceOf(Date);
      const events = await leadEvents(lead.id);
      expect(events.slice(-2).map((e) => e.metadata)).toEqual([
        {
          reason: 'LEAD_STAGE_CHANGED',
          statusChange: { from: 'NEW', to: 'SCHEDULED' },
          params: { appointmentId: first.id },
        },
        {
          reason: 'LEAD_STAGE_CHANGED',
          statusChange: { from: 'SCHEDULED', to: 'ATTENDED' },
          params: { appointmentId: first.id },
        },
      ]);
    });
  });

  describe('aislamiento', () => {
    it('otra clínica no ve nada (lectura, lista y escritura) y RLS rechaza filas ajenas', async () => {
      const lead = await create();
      await expect(asB(() => repo.findById(lead.id))).resolves.toBeNull();
      const listB = await asB(() => leads.list({}));
      expect(listB.items.map((i) => i.id)).not.toContain(lead.id);
      await expect(
        asB(() =>
          leads.changeStage(
            lead.id,
            { stage: 'CONTACTED' },
            audit(s.otherTenantId, s.otherAdminId, ClinicRole.ADMIN),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      await expect(
        asB(() =>
          leads.convert(
            lead.id,
            {},
            audit(s.otherTenantId, s.otherAdminId, ClinicRole.ADMIN),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      // Insertar una fila de A con el contexto de B: WITH CHECK.
      await expect(
        prisma.runWithTenant(s.otherTenantId, (tx) =>
          tx.lead.create({
            data: {
              tenantId: s.tenantId,
              locationId: s.chacao,
              fullName: 'Intruso',
              phone: '+58 412 0000000',
              phoneE164: '+584120000000',
              channel: 'OTHER',
              createdById: s.otherAdminId,
            },
          }),
        ),
      ).rejects.toThrow();
      // FK compuesta: un prospecto de B con la sede de A no entra.
      await expect(
        raw.lead.create({
          data: {
            tenantId: s.otherTenantId,
            locationId: s.chacao,
            fullName: 'Cruzado',
            phone: '+58 412 0000001',
            phoneE164: '+584120000001',
            channel: 'OTHER',
            createdById: s.otherAdminId,
          },
        }),
      ).rejects.toThrow();
    });

    it('un usuario de la sede Norte no ve ni toca los de Chacao (403) y la lista solo trae Norte', async () => {
      const chacao = await create({ locationId: s.chacao });
      const norte = await create({ locationId: s.norte });
      const onlyNorte = <T>(fn: () => Promise<T>) => asA(fn, [s.norte]);
      await expect(
        onlyNorte(() => leads.get(chacao.id)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        onlyNorte(() =>
          leads.changeStage(chacao.id, { stage: 'CONTACTED' }, audit()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        onlyNorte(() => leads.convert(chacao.id, {}, audit())),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        onlyNorte(() => leads.list({ locationId: s.chacao })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      const list = await onlyNorte(() => leads.list({ pageSize: 100 }));
      expect(list.items.every((i) => i.locationId === s.norte)).toBe(true);
      expect(list.items.map((i) => i.id)).toContain(norte.id);
      const board = await onlyNorte(() => leads.board({}));
      const ids = board.columns.flatMap((c) => c.items.map((i) => i.id));
      expect(ids).not.toContain(chacao.id);
      // «¿Quién llama?»: solo los de sus sedes.
      await expect(
        onlyNorte(() => leads.byPhones([`+${chacao.whatsAppDigits}`])),
      ).resolves.toEqual([]);
    });
  });

  describe('«Mi día» e informe', () => {
    it('sin contactar > 24 h: cuenta con la hora de la BD; una nota o una próxima acción futura lo saca', async () => {
      const before = await asA(() => leads.count({ locationId: s.norte }));
      const lead = await create({ locationId: s.norte });
      await backdate(lead.id, 'createdAt', 30);
      const stale = await asA(() => leads.count({ locationId: s.norte }));
      expect(stale.stale).toBe(before.stale + 1);
      const listed = await asA(() =>
        leads.list({ locationId: s.norte, stale: true, pageSize: 100 }),
      );
      expect(listed.total).toBe(stale.stale);
      expect(listed.items.map((i) => i.id)).toContain(lead.id);
      await asA(() =>
        leads.addNote(lead.id, 'Le escribí por WhatsApp', audit()),
      );
      expect(
        (await asA(() => leads.count({ locationId: s.norte }))).stale,
      ).toBe(before.stale);
      await backdate(lead.id, 'lastContactAt', 26);
      expect(
        (await asA(() => leads.count({ locationId: s.norte }))).stale,
      ).toBe(before.stale + 1);
      await asA(() =>
        leads.update(
          lead.id,
          { nextActionAt: new Date(Date.UTC(2099, 0, 1)) },
          audit(),
        ),
      );
      expect(
        (await asA(() => leads.count({ locationId: s.norte }))).stale,
      ).toBe(before.stale);
    });

    it('el informe por canal y responsable cuadra con la lista con los mismos filtros', async () => {
      const [{ now }] = await raw.$queryRaw<{ now: Date }[]>`
        SELECT timezone('UTC', now()) AS "now"`;
      const from = new Date(now.getTime() - 60_000);
      const a = await create({ channel: 'INSTAGRAM', locationId: s.norte });
      const b = await create({
        channel: 'INSTAGRAM',
        locationId: s.norte,
        ownerId: s.adminId,
      });
      await create({ channel: 'PHONE', locationId: s.norte, ownerId: null });
      for (const [i, lead] of [a, b].entries()) {
        const { patientId } = await asA(() =>
          leads.convert(lead.id, { lastName: 'Prueba' }, audit()),
        );
        const appt = await raw.appointment.create({
          data: {
            tenantId: s.tenantId,
            locationId: s.norte,
            patientId,
            providerId: s.dentistId,
            start: new Date(Date.UTC(2027, 4, 3 + i, 14)),
            end: new Date(Date.UTC(2027, 4, 3 + i, 14, 30)),
          },
        });
        await prisma.runWithTenant(s.tenantId, (tx) =>
          leadsOnAppointmentCreatedInTx(tx, {
            tenantId: s.tenantId,
            patientId,
            appointmentId: appt.id,
            actor: audit(),
          }),
        );
        if (lead === a) {
          await prisma.runWithTenant(s.tenantId, (tx) =>
            leadsOnAppointmentCompletedInTx(tx, {
              tenantId: s.tenantId,
              patientId,
              appointmentId: appt.id,
              actor: audit(),
            }),
          );
        }
      }
      // b se pierde tras tener cita: sigue contando como «con cita».
      await asA(() =>
        leads.changeStage(
          b.id,
          { stage: 'LOST', lostReason: 'Precio' },
          audit(),
        ),
      );
      const to = new Date(now.getTime() + 3_600_000);
      const report = await asA(() =>
        leads.report({ locationId: s.norte, from, to }),
      );
      const instagram = report.byChannel.find((r) => r.key === 'INSTAGRAM');
      expect(instagram).toMatchObject({
        leads: 2,
        scheduled: 2,
        attended: 1,
        scheduledRate: 1,
        attendedRate: 0.5,
        conversionRate: 0.5,
      });
      expect(report.byChannel.find((r) => r.key === 'PHONE')).toMatchObject({
        leads: 1,
        scheduled: 0,
        attended: 0,
      });
      // Cada cifra = el total de la lista con los mismos filtros.
      const total = (q: Parameters<LeadsUseCases['list']>[0]) =>
        asA(() =>
          leads.list({
            locationId: s.norte,
            createdFrom: from,
            createdTo: to,
            ...q,
          }),
        ).then((l) => l.total);
      for (const line of report.byChannel) {
        const channel = line.key as 'INSTAGRAM' | 'PHONE';
        expect(await total({ channel })).toBe(line.leads);
        expect(await total({ channel, reached: 'SCHEDULED' })).toBe(
          line.scheduled,
        );
        expect(await total({ channel, reached: 'ATTENDED' })).toBe(
          line.attended,
        );
      }
      for (const line of report.byOwner.filter((l) => l.key)) {
        expect(await total({ ownerId: line.key! })).toBe(line.leads);
        expect(await total({ ownerId: line.key!, reached: 'SCHEDULED' })).toBe(
          line.scheduled,
        );
      }
      // «Sin responsable» también cuadra (unowned).
      const unowned = report.byOwner.find((l) => l.key === null);
      expect(unowned?.leads).toBeGreaterThanOrEqual(1);
      expect(await total({ unowned: true })).toBe(unowned?.leads);
      expect(report.totals.leads).toBe(await total({}));
      expect(report.byOwner.reduce((acc, l) => acc + l.leads, 0)).toBe(
        report.totals.leads,
      );
    });
  });

  describe('retención', () => {
    it('anonimiza los perdidos con más meses de los de la clínica: sin nombre, teléfono ni notas; auditado sin usuario', async () => {
      const phone = nextPhone();
      const old = await create({ phone, fullName: 'Marisol Vargas' });
      await asA(() =>
        leads.addNote(old.id, 'Pidió precio de limpieza', audit()),
      );
      await asA(() =>
        leads.changeStage(
          old.id,
          { stage: 'LOST', lostReason: 'Precio' },
          audit(),
        ),
      );
      const recent = await create();
      await asA(() =>
        leads.changeStage(
          recent.id,
          { stage: 'LOST', lostReason: 'Precio' },
          audit(),
        ),
      );
      await raw.tenant.update({
        where: { id: s.tenantId },
        data: { leadLostRetentionMonths: 6 },
      });
      // 7 meses (≈ 212 días) atrás.
      await backdate(old.id, 'lostAt', 212 * 24);
      const done = await retention.anonymizeExpired(s.tenantId);
      expect(done).toBe(1);
      const row = await raw.lead.findUniqueOrThrow({ where: { id: old.id } });
      expect(row).toMatchObject({
        fullName: 'Anonimizado',
        phone: null,
        phoneE164: null,
        stage: 'LOST',
        lostReason: 'Precio',
        channel: 'WHATSAPP',
      });
      expect(row.anonymizedAt).toBeInstanceOf(Date);
      expect(await raw.leadNote.count({ where: { leadId: old.id } })).toBe(0);
      expect(
        (await raw.lead.findUniqueOrThrow({ where: { id: recent.id } }))
          .anonymizedAt,
      ).toBeNull();
      const [event] = (await leadEvents(old.id)).slice(-1);
      expect(event).toMatchObject({
        action: 'UPDATE',
        actorUserId: null,
        patientId: null,
        metadata: { reason: 'LEAD_ANONYMIZED', origin: 'JOB' },
      });
      // Idempotente; el número queda libre para un prospecto nuevo.
      await expect(retention.anonymizeExpired(s.tenantId)).resolves.toBe(0);
      await expect(create({ phone })).resolves.toMatchObject({ stage: 'NEW' });
      // Anonimizado: ni la app ni nadie lo modifica.
      await expect(
        asA(() => leads.changeStage(old.id, { stage: 'NEW' }, audit())),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        raw.$executeRaw`UPDATE "leads" SET "fullName" = 'Otra' WHERE "id" = ${old.id}::uuid`,
      ).rejects.toThrow(/anonimizado no se modifica/);
    });

    it('la app no borra prospectos ni edita notas', async () => {
      const lead = await create();
      const note = await asA(() =>
        leads.addNote(lead.id, 'Llamar el lunes', audit()),
      );
      await expect(
        prisma.runWithTenant(
          s.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "leads" WHERE "id" = ${lead.id}::uuid`,
        ),
      ).rejects.toThrow();
      await expect(
        prisma.runWithTenant(
          s.tenantId,
          (tx) =>
            tx.$executeRaw`UPDATE "lead_notes" SET "body" = 'x' WHERE "id" = ${note.id}::uuid`,
        ),
      ).rejects.toThrow(/no se modifica/);
      await expect(
        prisma.runWithTenant(
          s.tenantId,
          (tx) =>
            tx.$executeRaw`DELETE FROM "lead_notes" WHERE "id" = ${note.id}::uuid`,
        ),
      ).rejects.toThrow(/no se modifica/);
    });
  });
});
