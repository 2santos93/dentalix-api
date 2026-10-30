/**
 * DX-329 (spec §4.6; P2 y DX-312 P5): informe de SOLO LECTURA de los
 * teléfonos guardados que no encajan con la lectura de la librería. No
 * reescribe nada: el personal los corrige en la ficha, o un ticket aparte
 * aplica las propuestas que apruebe el dueño.
 *
 *   npm run phones:report
 *   npm run phones:report -- --detail
 *
 * Corre con el rol de la app (DATABASE_URL, RLS FORCE), nunca como
 * superusuario. Clínica a clínica, por lotes de `BATCH_SIZE` filas con clave
 * (`ORDER BY id`, `id > último`); cada lote en su propia transacción `READ
 * ONLY` con `runWithTenant` y un tope explícito.
 *
 * Imprime una línea JSON por clínica (subdominio, `multiRegion`, recuentos
 * por campo y categoría, y los de las banderas). Con `--detail`, después, un
 * CSV con una fila por valor que no sea `E164_VALID` ni `NATIONAL_VALID`, más
 * los que lleven `WHATSAPP_NOT_MOBILE` o `CHANGED_SINCE_DX329`. Nunca imprime
 * un número completo (solo los 4 últimos dígitos) ni un nombre.
 */
import { config as loadDotenv } from 'dotenv';
import { Prisma } from '@prisma/client';
import { parsePhoneNumberFromString } from 'libphonenumber-js/max';
import { normalizeMobile } from '../../src/modules/patients/domain/communication/mobile-number';
import {
  parsePhone,
  phoneRegionOrNull,
  readPhone,
  type PhoneReading,
  type PhoneRegion,
} from '../../src/shared/phone/phone-number';
import { PrismaService } from '../../src/shared/prisma/prisma.service';
import { TenantContextService } from '../../src/shared/tenancy/tenant-context.service';

export const BATCH_SIZE = 1000;
/** Tope de cada lote: muy por encima de lo que tarda leer 1 000 filas. */
export const BATCH_TIMEOUT_MS = 30_000;

/** Una categoría por valor: la primera que se cumple, en este orden. */
export const PHONE_CATEGORIES = [
  'E164_VALID',
  'E164_PROBABLE_WRONG_CODE',
  'E164_INVALID',
  'NATIONAL_NO_REGION',
  'NATIONAL_AMBIGUOUS',
  'NATIONAL_VALID',
  'NATIONAL_INVALID',
] as const;
export type PhoneCategory = (typeof PHONE_CATEGORIES)[number];

export const PHONE_FLAGS = [
  'CHANGED_SINCE_DX329',
  'WHATSAPP_NOT_MOBILE',
  'HAS_EXTENSION',
] as const;
export type PhoneFlag = (typeof PHONE_FLAGS)[number];

export const PHONE_FIELDS = [
  'patients.phone',
  'patients.emergencyContactPhone',
  'patients.physicianPhone',
  'patient_responsible_parties.phone',
  'locations.phone',
] as const;
export type PhoneField = (typeof PHONE_FIELDS)[number];

export interface ClinicPhonesReport {
  subdomain: string;
  /** Las sedes vivas tienen más de una región. */
  multiRegion: boolean;
  /** Lotes leídos (cada uno, una transacción `READ ONLY`). */
  batches: number;
  counts: Record<PhoneField, Partial<Record<PhoneCategory, number>>>;
  flags: Record<PhoneFlag, number>;
  /**
   * Pacientes de WhatsApp (canal u opt-in) sin teléfono. No es una bandera:
   * no hay número que clasificar ni listar.
   */
  whatsappWithoutPhone: number;
}

/** Una fila del detalle: el número y la propuesta, enmascarados. */
export interface PhoneDetail {
  subdomain: string;
  resource: 'patients' | 'patient_responsible_parties' | 'locations';
  id: string;
  field: string;
  category: PhoneCategory;
  flags: PhoneFlag[];
  phone: string;
  proposal: string | null;
}

export interface PhonesReport {
  clinics: ClinicPhonesReport[];
  details: PhoneDetail[];
}

// ---------------------------------------------------------------------------
// Regla anterior a DX-329: solo para comparar en el informe; no la usa la
// aplicación. Es la tabla provisional de DX-312, `toE164Digits` y la regla de
// móvil por indicativo, tal como estaban (CHANGED_SINCE_DX329).
// ---------------------------------------------------------------------------

/** Solo para comparar en el informe; no la usa la aplicación. */
const PREVIOUS_CODES: Readonly<Record<string, string>> = Object.freeze({
  AR: '54',
  BO: '591',
  BR: '55',
  CA: '1',
  CL: '56',
  CO: '57',
  CR: '506',
  CU: '53',
  DO: '1',
  EC: '593',
  ES: '34',
  GT: '502',
  HN: '504',
  MX: '52',
  NI: '505',
  PA: '507',
  PE: '51',
  PR: '1',
  PT: '351',
  PY: '595',
  SV: '503',
  US: '1',
  UY: '598',
  VE: '58',
});

/** Solo para comparar en el informe; no la usa la aplicación. */
const PREVIOUS_MOBILE_RULES: ReadonlyArray<[string, RegExp]> = [
  ['57', /^3\d{9}$/],
  ['34', /^[67]\d{8}$/],
];

/**
 * Solo para comparar en el informe; no la usa la aplicación. El E.164 (con
 * `+`) de la regla anterior, o `null`.
 */
function previousE164(phone: string, code: string | null): string | null {
  const trimmed = phone.trim();
  if (!trimmed || /[a-z]/i.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, '');
  let e164: string;
  if (trimmed.startsWith('+')) {
    e164 = digits;
  } else if (digits.startsWith('00')) {
    e164 = digits.slice(2);
  } else {
    if (!code) return null;
    const national = digits.replace(/^0+/, '');
    e164 =
      national.startsWith(code) && national.length - code.length >= 8
        ? national
        : `${code}${national}`;
  }
  return e164.length < 8 || e164.length > 15 ? null : `+${e164}`;
}

/** Solo para comparar en el informe; no la usa la aplicación. */
function previousMobileValid(phone: string, code: string | null): boolean {
  const e164 = previousE164(phone, code);
  if (!e164) return false;
  const digits = e164.slice(1);
  return PREVIOUS_MOBILE_RULES.every(
    ([prefix, mobile]) =>
      !digits.startsWith(prefix) || mobile.test(digits.slice(prefix.length)),
  );
}

// ---------------------------------------------------------------------------
// Clasificación (spec §4.6).
// ---------------------------------------------------------------------------

export interface PhoneClassification {
  category: PhoneCategory;
  /** E.164 propuesto, solo en `E164_PROBABLE_WRONG_CODE`. Nunca se imprime entero. */
  proposal: string | null;
  /** Lectura válida con extensión (m1). */
  extension: boolean;
}

const startsInternational = (text: string) =>
  text.startsWith('+') || text.replace(/\D/g, '').startsWith('00');

const validWithExtension = (reading: PhoneReading) =>
  reading.kind === 'VALID' && reading.phone.ext !== null;

/**
 * Un `+…` que no vale: al quitarle su indicativo (el que la librería separa
 * aunque el número no sea válido, m9), ¿lo lee como válido alguna región de
 * la clínica? Esa lectura es la propuesta.
 */
function wrongCodeProposal(
  text: string,
  regions: readonly PhoneRegion[],
): string | null {
  const code = parsePhoneNumberFromString(text)?.countryCallingCode;
  if (!code) return null;
  const digits = text.replace(/\D/g, '');
  const rest = digits.slice(code.length);
  for (const region of regions) {
    const reading = readPhone(rest, region);
    if (reading.kind === 'VALID' && reading.phone.digits !== digits) {
      return reading.phone.e164;
    }
  }
  return null;
}

/**
 * La categoría de un teléfono guardado con las regiones `regions`: las de las
 * sedes vivas de la clínica, o la de su sede para `locations.phone`. Un `00`
 * que alguna región lee de dos formas no es `E164_VALID`: es ambiguo (C1).
 */
export function classifyPhone(
  text: string,
  regions: readonly PhoneRegion[],
): PhoneClassification {
  const result = (
    category: PhoneCategory,
    extension = false,
    proposal: string | null = null,
  ): PhoneClassification => ({ category, proposal, extension });
  const byRegion = regions.map((region) => readPhone(text, region));
  const ambiguous = byRegion.some((r) => r.kind === 'AMBIGUOUS');

  if (startsInternational(text)) {
    const asPlus = readPhone(text, null);
    if (asPlus.kind === 'VALID' && (text.startsWith('+') || !ambiguous)) {
      return result('E164_VALID', validWithExtension(asPlus));
    }
    if (text.startsWith('+')) {
      const proposal = wrongCodeProposal(text, regions);
      return proposal
        ? result('E164_PROBABLE_WRONG_CODE', false, proposal)
        : result('E164_INVALID');
    }
  }
  if (regions.length === 0) return result('NATIONAL_NO_REGION');
  if (ambiguous) return result('NATIONAL_AMBIGUOUS');
  const valid = byRegion.find((r) => r.kind === 'VALID');
  if (valid) return result('NATIONAL_VALID', validWithExtension(valid));
  return result('NATIONAL_INVALID');
}

/**
 * `CHANGED_SINCE_DX329`: con la región de la sede principal, cambia el
 * estado de móvil o el E.164 entre la regla anterior y la librería.
 */
function changedSinceDx329(
  text: string,
  principal: PhoneRegion | null,
): boolean {
  const code = principal ? (PREVIOUS_CODES[principal] ?? null) : null;
  const before = previousMobileValid(text, code);
  const after = normalizeMobile(text, principal).status === 'VALID';
  const nowE164 = parsePhone(text, principal)?.e164 ?? null;
  return before !== after || previousE164(text, code) !== nowE164;
}

/** Los últimos dígitos: nunca más de 4 ni más de un tercio del número. */
export function maskPhone(text: string): string {
  const digits = text.replace(/\D/g, '');
  const shown = Math.min(4, Math.floor(digits.length / 3));
  return `***${shown > 0 ? digits.slice(-shown) : ''}`;
}

/** La propuesta con su indicativo (lo que cambia) y los 4 últimos dígitos. */
function maskProposal(e164: string): string {
  const code = parsePhoneNumberFromString(e164)?.countryCallingCode ?? '';
  return `+${code} ${maskPhone(e164)}`;
}

// ---------------------------------------------------------------------------
// Lectura: por clínica y por lotes, cada uno `READ ONLY`.
// ---------------------------------------------------------------------------

/**
 * Una transacción de solo lectura: con el tenant fijado (`runWithTenant`,
 * RLS FORCE) o, sin él, para `tenants`, que no tiene RLS. Cualquier
 * escritura dentro falla con 25006.
 */
export function readOnlyBatch<T>(
  prisma: PrismaService,
  tenantId: string | null,
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  const readOnly = async (tx: Prisma.TransactionClient) => {
    await tx.$executeRaw`SET TRANSACTION READ ONLY`;
    return fn(tx);
  };
  const options = { timeout: BATCH_TIMEOUT_MS };
  return tenantId
    ? prisma.runWithTenant(tenantId, readOnly, options)
    : prisma.$transaction(readOnly, options);
}

/** Todas las filas de una tabla, de `batchSize` en `batchSize` por su id. */
async function* keyset<T extends { id: string }>(
  prisma: PrismaService,
  tenantId: string,
  batchSize: number,
  page: (tx: Prisma.TransactionClient, after: string | null) => Promise<T[]>,
  onBatch: () => void,
): AsyncGenerator<T> {
  let after: string | null = null;
  for (;;) {
    const rows = await readOnlyBatch(prisma, tenantId, (tx) => page(tx, after));
    onBatch();
    yield* rows;
    if (rows.length < batchSize) return;
    after = rows[rows.length - 1].id;
  }
}

const idAfter = (after: string | null) => (after ? { id: { gt: after } } : {});

async function clinicReport(
  prisma: PrismaService,
  tenant: { id: string; subdomain: string },
  batchSize: number,
  details: PhoneDetail[],
): Promise<ClinicPhonesReport> {
  const tenantId = tenant.id;
  const report: ClinicPhonesReport = {
    subdomain: tenant.subdomain,
    multiRegion: false,
    batches: 0,
    counts: Object.fromEntries(
      PHONE_FIELDS.map((field) => [field, {}]),
    ) as ClinicPhonesReport['counts'],
    flags: Object.fromEntries(
      PHONE_FLAGS.map((flag) => [flag, 0]),
    ) as ClinicPhonesReport['flags'],
    whatsappWithoutPhone: 0,
  };
  const onBatch = () => {
    report.batches += 1;
  };

  // Sedes: sus regiones y sus teléfonos, cada uno con la región de su sede.
  const live: { id: string; createdAt: Date; region: PhoneRegion | null }[] =
    [];
  const locationPhones: {
    id: string;
    phone: string;
    region: PhoneRegion | null;
  }[] = [];
  for await (const l of keyset(
    prisma,
    tenantId,
    batchSize,
    (tx, after) =>
      tx.location.findMany({
        where: { tenantId, ...idAfter(after) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: {
          id: true,
          phone: true,
          defaultPhoneRegion: true,
          deletedAt: true,
          createdAt: true,
        },
      }),
    onBatch,
  )) {
    const region = phoneRegionOrNull(l.defaultPhoneRegion);
    if (l.deletedAt === null)
      live.push({ id: l.id, createdAt: l.createdAt, region });
    if (l.phone?.trim())
      locationPhones.push({ id: l.id, phone: l.phone, region });
  }
  // La principal: la primera creada y viva (como la del bloque de comunicaciones).
  const principal =
    live.sort(
      (a, b) =>
        a.createdAt.getTime() - b.createdAt.getTime() ||
        a.id.localeCompare(b.id),
    )[0]?.region ?? null;
  const regions = [
    ...new Set(
      live.map((l) => l.region).filter((r): r is PhoneRegion => r !== null),
    ),
  ];
  report.multiRegion = regions.length > 1;

  const record = (
    resource: PhoneDetail['resource'],
    id: string,
    field: string,
    text: string,
    readWith: readonly PhoneRegion[],
    extraFlags: PhoneFlag[] = [],
  ) => {
    const c = classifyPhone(text, readWith);
    const counts = report.counts[`${resource}.${field}` as PhoneField];
    counts[c.category] = (counts[c.category] ?? 0) + 1;
    const flags = PHONE_FLAGS.filter(
      (flag) =>
        extraFlags.includes(flag) || (flag === 'HAS_EXTENSION' && c.extension),
    );
    for (const flag of flags) report.flags[flag] += 1;
    const listed =
      (c.category !== 'E164_VALID' && c.category !== 'NATIONAL_VALID') ||
      flags.includes('CHANGED_SINCE_DX329') ||
      flags.includes('WHATSAPP_NOT_MOBILE');
    if (!listed) return;
    details.push({
      subdomain: tenant.subdomain,
      resource,
      id,
      field,
      category: c.category,
      flags,
      phone: maskPhone(text),
      proposal: c.proposal ? maskProposal(c.proposal) : null,
    });
  };

  for (const l of locationPhones) {
    record('locations', l.id, 'phone', l.phone, l.region ? [l.region] : []);
  }

  for await (const p of keyset(
    prisma,
    tenantId,
    batchSize,
    (tx, after) =>
      tx.patient.findMany({
        where: { tenantId, ...idAfter(after) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: {
          id: true,
          phone: true,
          emergencyContactPhone: true,
          physicianPhone: true,
          contactChannel: true,
          whatsappOptInAt: true,
        },
      }),
    onBatch,
  )) {
    const whatsapp =
      p.contactChannel === 'WHATSAPP' || p.whatsappOptInAt !== null;
    if (whatsapp && !p.phone?.trim()) report.whatsappWithoutPhone += 1;
    if (p.phone?.trim()) {
      const flags: PhoneFlag[] = [];
      if (changedSinceDx329(p.phone, principal))
        flags.push('CHANGED_SINCE_DX329');
      if (whatsapp && normalizeMobile(p.phone, principal).status !== 'VALID') {
        flags.push('WHATSAPP_NOT_MOBILE');
      }
      record('patients', p.id, 'phone', p.phone, regions, flags);
    }
    for (const field of ['emergencyContactPhone', 'physicianPhone'] as const) {
      const text = p[field];
      if (text?.trim()) record('patients', p.id, field, text, regions);
    }
  }

  for await (const r of keyset(
    prisma,
    tenantId,
    batchSize,
    (tx, after) =>
      tx.patientResponsibleParty.findMany({
        where: { tenantId, ...idAfter(after) },
        orderBy: { id: 'asc' },
        take: batchSize,
        select: { id: true, phone: true },
      }),
    onBatch,
  )) {
    if (r.phone?.trim()) {
      record('patient_responsible_parties', r.id, 'phone', r.phone, regions);
    }
  }

  return report;
}

export async function phonesReport(
  prisma: PrismaService,
  options: { batchSize?: number } = {},
): Promise<PhonesReport> {
  const batchSize = options.batchSize ?? BATCH_SIZE;
  const tenants = await readOnlyBatch(prisma, null, (tx) =>
    tx.tenant.findMany({
      select: { id: true, subdomain: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  );
  const clinics: ClinicPhonesReport[] = [];
  const details: PhoneDetail[] = [];
  for (const tenant of tenants) {
    clinics.push(await clinicReport(prisma, tenant, batchSize, details));
  }
  return { clinics, details };
}

const DETAIL_HEADER = [
  'subdominio',
  'recurso',
  'id',
  'campo',
  'categoria',
  'banderas',
  'numero',
  'propuesta',
];

/** El CSV de `--detail` (las celdas no llevan comas ni comillas). */
export function detailCsv(details: readonly PhoneDetail[]): string[] {
  return [
    DETAIL_HEADER.join(','),
    ...details.map((d) =>
      [
        d.subdomain,
        d.resource,
        d.id,
        d.field,
        d.category,
        d.flags.join('|'),
        d.phone,
        d.proposal ?? '',
      ].join(','),
    ),
  ];
}

async function main(): Promise<void> {
  loadDotenv({ quiet: true });
  const prisma = new PrismaService(new TenantContextService());
  try {
    const { clinics, details } = await phonesReport(prisma);
    for (const clinic of clinics) {
      console.log(JSON.stringify({ event: 'phones.report', ...clinic }));
    }
    if (process.argv.includes('--detail')) {
      for (const line of detailCsv(details)) console.log(line);
    }
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    // Sin el mensaje: un error de Prisma puede citar valores.
    const code =
      error instanceof Prisma.PrismaClientKnownRequestError
        ? error.code
        : error instanceof Error
          ? error.name
          : 'unknown';
    console.error(JSON.stringify({ event: 'phones.report_failed', code }));
    process.exit(1);
  });
}
