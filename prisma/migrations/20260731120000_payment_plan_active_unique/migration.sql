-- Partial unique index: at most one ACTIVE, non-deleted payment plan per
-- (tenant, treatment plan). Backstops the check-then-act in
-- CreatePaymentPlanUseCase against a concurrent double-POST race. Prisma's
-- DSL can't express partial indexes, so this lives only in SQL (same pattern
-- as payments_tenantId_paidAt_active_idx / users_email_key).
CREATE UNIQUE INDEX "payment_plans_active_unique"
  ON "payment_plans" ("tenantId", "treatmentPlanId")
  WHERE "status" = 'ACTIVE' AND "deletedAt" IS NULL;
