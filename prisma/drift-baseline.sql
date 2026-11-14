-- DropForeignKey
ALTER TABLE "appointment_plan_items" DROP CONSTRAINT "appointment_plan_items_appointment_fkey";

-- DropForeignKey
ALTER TABLE "appointment_plan_items" DROP CONSTRAINT "appointment_plan_items_item_fkey";

-- DropForeignKey
ALTER TABLE "patient_implants" DROP CONSTRAINT "patient_implants_tenantId_fkey";

-- DropForeignKey
ALTER TABLE "patient_implants" DROP CONSTRAINT "patient_implants_tenantId_treatmentPlanItemId_fkey";

-- DropForeignKey
ALTER TABLE "patient_ledgers" DROP CONSTRAINT "patient_ledgers_location_fkey";

-- DropForeignKey
ALTER TABLE "payments" DROP CONSTRAINT "payments_exchange_rate_currency_fkey";

-- DropForeignKey
ALTER TABLE "tooth_records" DROP CONSTRAINT "tooth_records_voidsRecordId_fkey";

-- DropForeignKey
ALTER TABLE "treatment_plan_items" DROP CONSTRAINT "treatment_plan_items_plan_patient_fkey";

-- DropForeignKey
ALTER TABLE "treatment_plans" DROP CONSTRAINT "treatment_plans_accepted_location_fkey";

-- DropIndex
DROP INDEX "closing_queue_dismissals_pending_key";

-- DropIndex
DROP INDEX "icd10_codes_search_text_trgm_idx";

-- DropIndex
DROP INDEX "patient_implants_tenant_lot_key_idx";

-- DropIndex
DROP INDEX "patient_implants_tenant_reference_key_idx";

-- DropIndex
DROP INDEX "treatment_plan_items_tenant_id_key";

-- AlterTable
ALTER TABLE "appointment_plan_items" ALTER COLUMN "createdAt" SET DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "icd10_codes" ALTER COLUMN "search_text" SET DEFAULT dx_search_normalize((((code || ' '::text) || replace(code, '.'::text, ''::text)) || ' '::text) || label_es);

-- AlterTable
ALTER TABLE "patients" ALTER COLUMN "patientCode" SET DEFAULT 0;

-- DropTable
DROP TABLE "payments_paidat_backfill_dx097";

-- CreateIndex
CREATE UNIQUE INDEX "agreements_tenant_name_key" ON "agreements"("tenantId", "name");

-- CreateIndex
CREATE INDEX "appointment_waitlist_open_panel_idx" ON "appointment_waitlist"("tenantId", "locationId", "priority" DESC, "createdAt", "id");

-- CreateIndex
CREATE UNIQUE INDEX "appointment_waitlist_tenant_source_key" ON "appointment_waitlist"("tenantId", "sourceAppointmentId");

-- CreateIndex
CREATE UNIQUE INDEX "appointments_tenant_idempotency_key" ON "appointments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_invitations_pending_key" ON "clinic_invitations"("tenantId", "email");

-- CreateIndex
CREATE UNIQUE INDEX "clinic_memberships_tenantId_userId_key" ON "clinic_memberships"("tenantId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "catalog_tenant_code_key" ON "dental_catalog_items"("tenantId", "code");

-- CreateIndex
CREATE INDEX "equipment_tenant_active_location_idx" ON "equipment"("tenantId", "locationId");

-- CreateIndex
CREATE INDEX "expense_payments_tenant_location_paid_on_idx" ON "expense_payments"("tenantId", "locationId", "paidOn");

-- CreateIndex
CREATE UNIQUE INDEX "mhv_tenant_patient_version_key" ON "medical_history_versions"("tenantId", "patientId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_refunds_tenant_idempotency_key" ON "patient_credit_refunds"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "patient_credit_transfers_tenant_idempotency_key" ON "patient_credit_transfers"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "patients_tenant_doc_key" ON "patients"("tenantId", "docNumber");

-- CreateIndex
CREATE UNIQUE INDEX "payers_tenant_name_key" ON "payers"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_tenant_legacy_key" ON "payment_methods"("tenantId", "legacyMethod");

-- CreateIndex
CREATE INDEX "payments_tenantId_paidAt_active_idx" ON "payments"("tenantId", "paidAt");

-- CreateIndex
CREATE INDEX "payments_tenantId_locationId_paidAt_active_idx" ON "payments"("tenantId", "locationId", "paidAt");

-- CreateIndex
CREATE INDEX "payments_tenant_cash_session_idx" ON "payments"("tenantId", "cashSessionId");

-- CreateIndex
CREATE INDEX "payments_exchange_rate_pending_idx" ON "payments"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "payments_exchange_rate_manual_idx" ON "payments"("tenantId", "exchangeRateDate");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_idempotency_key" ON "payments"("tenantId", "idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "payments_tenant_split_line_key" ON "payments"("tenantId", "splitId", "splitLine");

-- CreateIndex
CREATE UNIQUE INDEX "prescription_templates_tenant_name_key" ON "prescription_templates"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "price_lists_tenant_name_key" ON "price_lists"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "provider_schedule_overrides_live_key" ON "provider_schedule_overrides"("tenantId", "providerId", "locationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "provider_schedules_live_key" ON "provider_schedules"("tenantId", "providerId", "locationId");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_verified_host_key" ON "tenant_domains"("host");

-- CreateIndex
CREATE INDEX "tenant_domains_host_idx" ON "tenant_domains"("host");

-- CreateIndex
CREATE UNIQUE INDEX "tenant_domains_tenant_host_key" ON "tenant_domains"("tenantId", "host");

-- CreateIndex
CREATE UNIQUE INDEX "tenants_subdomain_key" ON "tenants"("subdomain");

-- CreateIndex
CREATE UNIQUE INDEX "tooth_records_source_plan_item_key" ON "tooth_records"("tenantId", "sourcePlanItemId");

-- CreateIndex
CREATE UNIQUE INDEX "tooth_records_void_once_key" ON "tooth_records"("tenantId", "voidsRecordId");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- RenameForeignKey
ALTER TABLE "reminder_opt_out_match_warnings" RENAME CONSTRAINT "opt_out_match_warnings_patient_fkey" TO "reminder_opt_out_match_warnings_tenantId_patientId_fkey";

-- RenameForeignKey
ALTER TABLE "reminder_opt_out_match_warnings" RENAME CONSTRAINT "opt_out_match_warnings_tenant_fkey" TO "reminder_opt_out_match_warnings_tenantId_fkey";

-- RenameForeignKey
ALTER TABLE "waitlist_offers" RENAME CONSTRAINT "waitlist_offers_appointment_fkey" TO "waitlist_offers_tenantId_appointmentId_fkey";

-- RenameForeignKey
ALTER TABLE "waitlist_offers" RENAME CONSTRAINT "waitlist_offers_entry_fkey" TO "waitlist_offers_tenantId_waitlistEntryId_fkey";

-- RenameForeignKey
ALTER TABLE "waitlist_offers" RENAME CONSTRAINT "waitlist_offers_location_fkey" TO "waitlist_offers_tenantId_locationId_fkey";

-- RenameForeignKey
ALTER TABLE "waitlist_offers" RENAME CONSTRAINT "waitlist_offers_patient_fkey" TO "waitlist_offers_tenantId_patientId_fkey";

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_exchange_rate_currency_fkey" FOREIGN KEY ("exchangeRateCurrency") REFERENCES "currencies"("code") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_plan_items" ADD CONSTRAINT "appointment_plan_items_tenantId_patientId_appointmentId_fkey" FOREIGN KEY ("tenantId", "patientId", "appointmentId") REFERENCES "appointments"("tenantId", "patientId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "appointment_plan_items" ADD CONSTRAINT "appointment_plan_items_tenantId_patientId_planItemId_fkey" FOREIGN KEY ("tenantId", "patientId", "planItemId") REFERENCES "treatment_plan_items"("tenantId", "patientId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- RenameIndex
ALTER INDEX "appointment_plan_items_item_idx" RENAME TO "appointment_plan_items_tenantId_planItemId_appointmentId_idx";

