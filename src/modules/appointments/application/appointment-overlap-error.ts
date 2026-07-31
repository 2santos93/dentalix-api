import { Prisma } from '@prisma/client';

/**
 * True when `error` is the Postgres exclusion-constraint violation (SQLSTATE
 * 23P01) raised by `appointments_no_overlap_per_provider` — the DB-level
 * guarantee against provider double-booking. This closes the check-then-insert
 * race the `findOverlapping` pre-check alone cannot: two concurrent
 * creates/reschedules can both pass the pre-check and only collide at INSERT.
 *
 * Prisma surfaces 23P01 in TWO shapes (both handled):
 *  - ORM `tx.appointment.create()/update()` (what the repo uses): a
 *    `PrismaClientUnknownRequestError` with NO `.code`/`.meta`; the SQLSTATE
 *    `23P01` appears only inside `.message`. The global `PrismaExceptionFilter`
 *    (`@Catch(PrismaClientKnownRequestError)`, P2002 only) does NOT catch it,
 *    which is why the use-case maps it explicitly.
 *  - raw `$executeRaw` (defensive/future-proof): a
 *    `PrismaClientKnownRequestError` code `P2010` with `meta.code === '23P01'`.
 */
export function isProviderOverlapExclusionViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientUnknownRequestError) {
    return error.message.includes('23P01');
  }
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === 'P2010'
  ) {
    const meta = error.meta as { code?: string } | undefined;
    return meta?.code === '23P01' || error.message.includes('23P01');
  }
  return false;
}
