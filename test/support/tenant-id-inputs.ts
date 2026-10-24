import { RouteAccess } from './route-access-matrix';
import { DiscoveredRoute } from './route-discovery';
import { uuidInputsOf } from './uuid-inputs';

/**
 * DX-207 (TST-022): invariante de aislamiento para los ids de recurso que una
 * ruta de clínica (`roles`) recibe por la QUERY o el CUERPO.
 *
 * Cada id (`MÉTODO /ruta ?campo` o `MÉTODO /ruta body.campo`, ver
 * `uuid-inputs.ts`) debe tener:
 *  - un caso en `test/tenant-isolation-matrix.e2e-spec.ts` (la clínica B
 *    manda el id de A y se exige 400/404 en español o una lista sin filas de
 *    A, con la fotografía de A intacta): va en `ID_INPUTS_IN_MATRIX`, y la
 *    matriz comprueba que sus casos `queryIds`/`bodyIds` son exactamente
 *    estos; o
 *  - una exención en `ID_INPUTS_COVERED_ELSEWHERE` que cita el spec que ya lo
 *    prueba.
 *
 * `src/tenant-id-inputs.spec.ts` (unit, `npm test`) descubre los ids de cada
 * ruta y falla con el nombre de la ruta y del campo si uno no está en
 * ninguna de las dos listas (o si una entrada ya no existe).
 */

export const TENANT_ISOLATION_MATRIX_SPEC =
  'tenant-isolation-matrix.e2e-spec.ts';

export const ID_INPUTS_IN_MATRIX: readonly string[] = [
  // --- auditoría (DX-009) ---
  'GET /audit-events ?actorUserId',
  'GET /audit-events ?patientId',
  // --- pacientes, cobertura y convenios (DX-105, DX-150, DX-153) ---
  'POST /patients body.dataConsents.policyVersionId',
  'GET /patients ?payerId',
  'POST /patients/:id/payment-promises body.locationId',
  'POST /patients/:patientId/coverages body.payerId',
  'PATCH /patients/:patientId/coverages/:coverageId body.payerId',
  'PUT /patients/:patientId/agreement body.agreementId',
  'PUT /patients/:patientId/agreement body.coverageId',
  'POST /agreements body.locationId',
  'POST /agreements body.payerId',
  'POST /agreements body.priceListId',
  'PATCH /agreements/:id body.locationId',
  'PATCH /agreements/:id body.payerId',
  'PATCH /agreements/:id body.priceListId',
  'POST /price-lists body.locationId',
  'PATCH /price-lists/:id body.locationId',
  'PUT /price-lists/:id/items body.items[].catalogItemId',
  'GET /patients/:patientId/price-quote ?catalogItemId',
  // --- historia clínica y odontograma ---
  'POST /patients/:patientId/clinical-entries body.answers[].promptId',
  'POST /patients/:patientId/clinical-entries body.appointmentId',
  'POST /patients/:patientId/clinical-entries body.templateId',
  'POST /patients/:patientId/tooth-records body.catalogItemId',
  'POST /patients/:patientId/tooth-records body.clinicalEntryId',
  // --- agenda (DX-122, DX-210, DX-233) ---
  'POST /appointments body.appointmentTypeId',
  'POST /appointments body.patientId',
  'POST /appointments body.planItemIds[]',
  'POST /appointments body.providerId',
  'GET /appointments ?locationId',
  'GET /appointments ?providerId',
  'GET /appointments ?providerIds[]',
  'GET /appointments/openings ?locationId',
  'GET /appointments/openings ?patientId',
  'GET /appointments/openings ?providerId',
  'PATCH /appointments/:id body.planItemIds[]',
  'PATCH /appointments/:id body.providerId',
  'PATCH /appointments/:id/opening body.providerId',
  'PUT /staff/:userId/locations body.locationIds[]',
  'GET /schedule-blocks ?locationId',
  'GET /schedule-blocks ?providerIds[]',
  'GET /schedule-blocks/affected-appointments ?locationId',
  'GET /schedule-blocks/affected-appointments ?providerId',
  'POST /schedule-blocks body.locationId',
  'POST /schedule-blocks body.providerId',
  'PUT /providers/:providerId/schedule body.locations[].locationId',
  'POST /providers/:providerId/schedule-overrides body.locationId',
  'GET /schedule/roster ?locationId',
  'GET /waitlist ?locationId',
  'POST /waitlist body.appointmentTypeId',
  'POST /waitlist body.locationId',
  'POST /waitlist body.patientId',
  'POST /waitlist body.providerId',
  'POST /waitlist/:id/schedule body.appointmentTypeId',
  'POST /waitlist/:id/schedule body.providerId',
  'GET /appointments/openings/:locationId/candidates ?providerId',
  'POST /appointments/openings/:locationId/offers body.appointmentId',
  'POST /appointments/openings/:locationId/offers body.patientId',
  'POST /appointments/openings/:locationId/offers body.providerId',
  'POST /appointments/openings/:locationId/offers body.waitlistEntryId',
  // --- planes de tratamiento ---
  'GET /treatment-plans/unscheduled ?cursor',
  'GET /treatment-plans/unscheduled ?locationId',
  'PATCH /treatment-plans/:id/visits body.items[].itemId',
  'POST /treatment-plans/:id/items body.catalogItemId',
  'POST /treatment-plans/:id/items/bulk-discount body.itemIds[]',
  'PATCH /treatment-plans/:id/items/:itemId body.performedById',
  // --- reportes, cartera y caja (DX-027, DX-204) ---
  'GET /reports/discounts ?locationId',
  'GET /reports/discounts ?professionalId',
  'GET /reports/discounts.csv ?locationId',
  'GET /reports/discounts.csv ?professionalId',
  'GET /receivables/aging ?locationId',
  'GET /receivables/aging ?providerId',
  'GET /receivables/aging.csv ?locationId',
  'GET /receivables/aging.csv ?providerId',
  'GET /cash-sessions/current ?locationId',
  'POST /cash-sessions/open body.locationId',
  'GET /cash-sessions ?locationId',
  // --- consentimientos, indicaciones y anamnesis ---
  'GET /patients/:patientId/consents/preview ?templateId',
  'GET /patients/:patientId/consents/preview ?treatmentPlanId',
  'POST /patients/:patientId/consents body.templateId',
  'POST /patients/:patientId/consents body.treatmentPlanId',
  'POST /post-op-templates body.appointmentTypeIds[]',
  'PATCH /post-op-templates/:id body.appointmentTypeIds[]',
  'PATCH /post-op-templates/:id body.catalogItemIds[]',
  'POST /appointments/:appointmentId/post-op-instructions/deliveries body.templateId',
  'POST /patients/:patientId/medical-history/requests body.appointmentId',
];

/** Ids cuyo caso «B manda el id de A» ya está en otro spec (se cita cuál). */
export const ID_INPUTS_COVERED_ELSEWHERE: Record<string, string> = {
  // «la clínica B no puede usar la política de A para su propio paciente (409)».
  'POST /patients/:patientId/data-consents body.policyVersionId':
    'data-consents.e2e-spec.ts',
  // «404 si cualquier id es ajeno»: una evolución de la clínica B en el lote.
  'GET /patients/:patientId/clinical-entries/rda-readiness ?ids[]':
    'rda-codes.e2e-spec.ts',
  // «el ítem del plan tiene que ser de un plan del MISMO paciente y clínica».
  'POST /patients/:patientId/implants body.treatmentPlanItemId':
    'implants.e2e-spec.ts',
  // «no se puede vincular a un paciente de otra clínica (404)».
  'POST /patients/:patientId/responsible-parties body.responsiblePatientId':
    'patient-responsible-parties.e2e-spec.ts',
  // «un ítem … de otra clínica … dan 400» (procedimiento de otra clínica).
  'POST /post-op-templates body.catalogItemIds[]':
    'post-op-templates.e2e-spec.ts',
  // DX-274: gastos. «Una sede de otra clínica es 400 (alta y edición)» y «la
  // subida de otra clínica es 404» (alta y adjuntar después).
  'POST /expenses body.locationId': 'expenses.e2e-spec.ts',
  'PATCH /expenses/:id body.locationId': 'expenses.e2e-spec.ts',
  'POST /expenses body.attachmentUploadId': 'expenses.e2e-spec.ts',
  'POST /expenses/:id/attachment body.uploadId': 'expenses.e2e-spec.ts',
  // La salida de caja pasa por el mismo alta y la misma comprobación de la
  // subida (`ExpenseReceiptUploads`, por clínica y usuario).
  'POST /cash-sessions/current/outflows body.attachmentUploadId':
    'expenses.e2e-spec.ts',
  // Una sede ajena en la lista, el resumen y sus CSV no devuelve nada.
  'GET /expenses ?locationId': 'expenses-reports.e2e-spec.ts',
  'GET /expenses.csv ?locationId': 'expenses-reports.e2e-spec.ts',
  'GET /expenses/summary ?locationId': 'expenses-reports.e2e-spec.ts',
  'GET /expenses/summary.csv ?locationId': 'expenses-reports.e2e-spec.ts',
};

/** Ids por query/cuerpo de las rutas de clínica (`roles`) dadas. */
export function tenantIdInputs(
  routes: DiscoveredRoute[],
  access: Record<string, RouteAccess>,
): string[] {
  return routes
    .filter((route) => access[route.key]?.kind === 'roles')
    .flatMap((route) =>
      uuidInputsOf(route.controllerClass, route.handler).map(
        (field) => `${route.key} ${field}`,
      ),
    )
    .sort();
}

/**
 * Diferencias entre los ids descubiertos y las dos listas: ids sin caso ni
 * exención, entradas que ya no corresponden a ningún id y entradas repetidas
 * (en la matriz y exentas a la vez).
 */
export function idInputCoverageGaps(
  discovered: string[],
  inMatrix: readonly string[] = ID_INPUTS_IN_MATRIX,
  elsewhere: Record<string, string> = ID_INPUTS_COVERED_ELSEWHERE,
): { sinCaso: string[]; entradaSinId: string[]; duplicada: string[] } {
  const covered = [...inMatrix, ...Object.keys(elsewhere)];
  return {
    sinCaso: discovered.filter((id) => !covered.includes(id)),
    entradaSinId: covered.filter((id) => !discovered.includes(id)),
    duplicada: covered.filter((id, i) => covered.indexOf(id) !== i),
  };
}
