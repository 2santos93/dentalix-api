import { installFakeNow } from './support/fake-now';

// DX-460: E2E_FAKE_NOW mueve el reloj del proceso (ver support/fake-now.ts).
installFakeNow();

// DX-021-bis: las clínicas nuevas nacen exigiendo el MFA a sus ADMIN. Las suites
// registran clínicas y entran con contraseña, igual que las e2e (setup-e2e.ts).
process.env.NEW_CLINIC_REQUIRE_ADMIN_MFA ??= 'false';
