// DX-021-bis: las clínicas nuevas nacen exigiendo el MFA a sus ADMIN. Las suites
// registran clínicas y entran con contraseña, igual que las e2e (setup-e2e.ts).
process.env.NEW_CLINIC_REQUIRE_ADMIN_MFA ??= 'false';
