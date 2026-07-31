# Remove OWNER role — backend report

Branch: `feat/remove-owner-role` (worktree `dentalix-api-noowner`).
Design doc: `docs/plans/2026-07-31-remove-owner-role.md`.

## What changed

### 1. Schema + migration
- `prisma/schema.prisma`: `enum ClinicRole` is now `DENTIST, ASSISTANT, RECEPTION, ADMIN` (no `OWNER`).
- New hand-written migration `prisma/migrations/20260731170000_remove_owner_role/migration.sql`:
  `UPDATE clinic_memberships SET role='ADMIN' WHERE role='OWNER'` first, then the enum-type swap
  (`RENAME` old enum → `CREATE TYPE` new → `ALTER COLUMN ... USING` cast → `DROP TYPE` old). Applied
  successfully to both `dentalix_noowner` (dev) and `dentalix_noowner_e2e` (e2e) via `prisma migrate deploy`.

### 2. Backend code
- `auth/infrastructure/repositories/prisma-auth.repository.ts`: `register` now creates the founding
  membership with `ClinicRole.ADMIN` (was `OWNER`).
- `auth/presentation/guards/clinic-role-sets.ts`: removed `ClinicRole.OWNER` from all 9 exported role
  sets (`PATIENT_ROLES`, `CLINICAL_ROLES`, `CATALOG_READ_ROLES`, `CATALOG_WRITE_ROLES`,
  `APPOINTMENT_ROLES`, `PAYMENT_ROLES`, `INVENTORY_ROLES`, `DASHBOARD_ROLES`, `STAFF_WRITE_ROLES`) and
  updated every comment that named OWNER.
- `domains/presentation/domains.controller.ts`: `@Roles(ClinicRole.OWNER)` → `@Roles(ClinicRole.ADMIN)`,
  with a new comment explaining domains are now ADMIN-gated.
- `payments/`, `treatment-plans/`, `dashboard/`, `inventory/` controllers: comments that named OWNER
  updated to ADMIN (no behavioural change there, they already used the shared role-set constants).

### 3. Anti-lockout rename (the critical part)
- `staff/domain/ports/staff-repository.port.ts`: `countActiveOwners()` → `countActiveAdmins()` (+ doc).
- `staff/infrastructure/repositories/prisma-staff.repository.ts`: implementation renamed, query now
  filters `role: ClinicRole.ADMIN` (was `OWNER`).
- `staff/application/use-cases/deactivate-staff.use-case.ts`: compares `current.role === ClinicRole.ADMIN`
  and calls `countActiveAdmins()`; message changed to **"Cannot deactivate the last admin"**.
- `staff/application/use-cases/update-staff.use-case.ts`: same rename; message changed to
  **"Cannot demote the last admin"**. Messages kept in English per the owner's decision.
- Every use-case spec and fake (`list-staff.use-case.spec.ts`'s repo fake included — its
  `countActiveOwners` stub was easy to miss since `grep OWNER` doesn't match camelCase `Owners`) now
  implements/asserts `countActiveAdmins`, and the "last admin" 409 specs still exist and still cover
  the protection (not weakened, not deleted).

### 4. Tests swept (`OWNER` → `ADMIN`)
All 18 pre-existing files (10 unit specs + 8 e2e specs) that referenced `ClinicRole.OWNER` / the string
`'OWNER'` were updated. Two required actual logic changes, not just find/replace:

- **`test/staff.e2e-spec.ts`** (step 4a/4b): the original "delete the last OWNER" test relied on OWNER
  and ADMIN being *different* roles that both had `STAFF_WRITE_ROLES` permission, so an ADMIN actor
  could attempt to deactivate the sole OWNER without tripping "cannot deactivate yourself" and without
  affecting the OWNER-count. With OWNER gone, `STAFF_WRITE_ROLES` is ADMIN-only, so a second admin
  actor would always count toward `countActiveAdmins()` and the scenario would no longer produce a
  "last admin" 409. Rewrote it: seed a second ADMIN, log it in (JWT snapshot: role=ADMIN), have the
  first admin legitimately PATCH the second admin's role down to DENTIST (leaving exactly one active
  admin in the DB), then use the *second admin's stale JWT* (RolesGuard reads the role off the JWT, not
  a fresh DB lookup — same mechanism already exploited by this file's own step-3 DENTIST-token probe)
  to attempt deactivating the first admin as a genuinely different actor → 409. Step 4b then deletes the
  demoted (now DENTIST) second admin as the "normal member deletion succeeds" case.
- **`rls.isolation.int-spec.ts`** / **`appointments.e2e-spec.ts`** / **`me.e2e-spec.ts`**: direct
  `ClinicRole.OWNER` seeds/assertions swapped for `ADMIN` (register now creates ADMIN, so the asserted
  role in `me.e2e-spec.ts` and `appointments.e2e-spec.ts` changed accordingly).
- All other occurrences (role-matrix, payments, dashboard, inventory, treatment-plans, payment-plans
  e2e specs; auth/roles-guard/token/tenant-context unit specs) were comment-only or straight
  `OWNER`→`ADMIN` role substitutions with no behavioural implications.
- `domains.e2e-spec.ts` has no existing 403-for-non-owner test to update — none exists in this repo.

## Verification

1. `npx prisma migrate deploy` (dev DB `dentalix_noowner`) — applied cleanly.
2. `npx prisma generate` — OK.
3. Data-conversion proof (dev DB, after migration):
   - `SELECT role, count(*) FROM clinic_memberships GROUP BY role;` → `ADMIN | 1` (the seeded OWNER
     membership converted).
   - `SELECT unnest(enum_range(NULL::"ClinicRole"))::text;` → `DENTIST, ASSISTANT, RECEPTION, ADMIN`
     (4 values, no OWNER).
4. `npx dotenv -e .env.test -- npx prisma migrate deploy` (e2e DB `dentalix_noowner_e2e`) — applied cleanly.
5. `npm run build` — clean, no errors.
6. `npm test` — **454 passed, 454 total** (81 suites), 0 failures.
7. `npm run test:e2e` — **46 passed, 15 failed** (13 suites passed, 9 failed), see below.

### e2e failures — none caused by this change

- **`reference.e2e-spec.ts`, `patients-location.e2e-spec.ts`** — fail for missing Colombia
  reference-seed data in this fresh DB. Pre-existing and explicitly expected per the task brief;
  unrelated to roles.
- **`payments.e2e-spec.ts`, `treatment-plans.e2e-spec.ts`** — their actual test assertions **pass**
  (`1 passed`), but each suite's `cleanup()`/`afterAll` helper does `patient.deleteMany()` without
  first deleting `tooth_records`, and a treatment-plan-item write in these tests reflects into the
  odontogram (creates a `tooth_records` row), so the cleanup's own FK constraint
  (`tooth_records_patientId_fkey`) trips and Jest reports the *suite* as failed even though the test
  itself succeeded. Confirmed pre-existing: this repo's git diff for both files touches only comments
  (`OWNER`→`ADMIN`), never the cleanup logic. Verified in isolation (fresh truncated DB, single-file
  jest run) — same result, so it's not an interaction with anything I changed.
- **`clinical-history.e2e-spec.ts`, `patients.e2e-spec.ts`, `payment-plans.e2e-spec.ts`,
  `dashboard.e2e-spec.ts`, `appointments.e2e-spec.ts`** — these only fail when run in the *same* Jest
  invocation *after* `payments`/`treatment-plans` (which leave orphaned `tooth_records`+`patients` rows
  behind because their own cleanup throws before finishing). Verified: each of these 5 files, run
  individually against a freshly truncated e2e DB, **passes** (confirmed with a targeted run of each).
  This is cross-suite pollution caused by the pre-existing `payments`/`treatment-plans` cleanup bug,
  not by the OWNER removal.
- **Everything role-related passed**, including the critical ones: `staff.e2e-spec.ts` (anti-lockout,
  now for "last admin"), `domains.e2e-spec.ts`, `role-matrix.e2e-spec.ts`, `auth.e2e-spec.ts`,
  `me.e2e-spec.ts` — confirmed both in the full run and in an isolated re-run of just these 5 files
  (17/17 tests green).

I did not touch the `payments`/`treatment-plans` cleanup helpers or the Colombia seed — out of scope
for this atomic role-removal change, and fixing them risks masking or conflating with this diff. Flagging
for a separate follow-up.

## Anti-lockout protection — confirmed preserved

- `DeactivateStaffUseCase`: blocks deactivating the last active ADMIN → `ConflictException('Cannot
  deactivate the last admin')`, still covered by `deactivate-staff.use-case.spec.ts` (unit) and
  `staff.e2e-spec.ts` step 4a (e2e, real HTTP path with a genuinely different actor, see above).
- `UpdateStaffUseCase`: blocks demoting the last active ADMIN away from ADMIN → `ConflictException('Cannot
  demote the last admin')`, still covered by `update-staff.use-case.spec.ts`.
- Both still rely on `StaffRepository.countActiveAdmins()`, backed by the same Prisma query shape as
  before (now filtered on `role: ADMIN`).

## Commit

One commit on `feat/remove-owner-role` containing the enum/migration/code/test changes described above.
