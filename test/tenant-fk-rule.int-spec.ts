import { Prisma, PrismaClient } from '@prisma/client';

// DX-148 (decisión única de la FK de `tenantId`, heredada de DX-104/DB-028):
// TODA tabla de clínica con columna `tenantId` lleva una FK directa
// ("tenantId") REFERENCES "tenants"("id"), además de las compuestas
// (tenantId, x) hacia sus padres (SEC-004). ON DELETE RESTRICT por defecto:
// borrar una clínica es la purga explícita del owner, que vacía antes sus
// tablas; CASCADE solo en datos operativos y regenerables (colas, contadores,
// ajustes de envío). README, «Migraciones en caliente».
//
// Las tablas de abajo son anteriores a la regla y no la cumplen (las del
// núcleo nunca la tuvieron). La lista está CONGELADA: solo puede encoger.
// DX-058-bis sacó las tres raíces (patients, locations, location_schedules),
// con NOT VALID y VALIDATE en migraciones separadas; el resto cuelga de ellas
// por FK compuestas (tenantId, …).
// Una tabla nueva sin la FK hace fallar este test.
const WITHOUT_DIRECT_TENANT_FK = [
  'appointment_plan_items',
  'appointment_status_reversals',
  'appointments',
  // Registro que sobrevive a la clínica; particionada (DX-102).
  'audit_events',
  'cancellation_fees',
  'cancellation_policy_versions',
  'cash_session_adjustments',
  'cash_session_closing_lines',
  'cash_session_closings',
  'cash_session_floats',
  'cash_session_reopenings',
  'clinical_entries',
  'clinical_note_template_prompts',
  'dental_catalog_items',
  'installments',
  'inventory_items',
  'inventory_movements',
  'location_schedule_ranges',
  'medical_history_versions',
  'membership_locations',
  'patient_consents',
  'patient_ledgers',
  'patient_retention_actions',
  'payment_base_retries',
  'payment_plans',
  'payments',
  // Tabla de operación de DX-097, sin GRANT a la app.
  'payments_paidat_backfill_dx097',
  'perio_exams',
  'perio_site_measures',
  'perio_tooth_measures',
  'prescription_items',
  'prescriptions',
  'provider_schedule_override_ranges',
  'provider_schedule_ranges',
  'tooth_records',
  'treatment_plan_acceptances',
  'treatment_plan_items',
  'treatment_plan_repricings',
  'treatment_plans',
];

const owner = new PrismaClient<Prisma.PrismaClientOptions>({
  datasources: { db: { url: process.env.DIRECT_URL } },
});

describe('DX-148 · FK directa de tenantId a tenants (int)', () => {
  afterAll(() => owner.$disconnect());

  it('toda tabla con tenantId la tiene, salvo la lista congelada (que no crece ni sobra)', async () => {
    const rows = await owner.$queryRaw<{ relname: string }[]>`
      SELECT c.relname
        FROM pg_class c
        JOIN pg_attribute a
          ON a.attrelid = c.oid AND a.attname = 'tenantId' AND NOT a.attisdropped
       WHERE c.relnamespace = 'public'::regnamespace
         AND c.relkind IN ('r', 'p') AND NOT c.relispartition
         AND NOT EXISTS (
           SELECT 1 FROM pg_constraint k
            WHERE k.contype = 'f' AND k.conrelid = c.oid
              AND k.confrelid = 'public.tenants'::regclass
              AND k.conkey = ARRAY[a.attnum])
       ORDER BY 1`;
    expect(rows.map((r) => r.relname)).toEqual(
      [...WITHOUT_DIRECT_TENANT_FK].sort(),
    );
  });
});
