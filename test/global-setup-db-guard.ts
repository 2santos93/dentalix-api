import { loadTestEnvAndAssertDatabase } from './support/test-db-guard';

// DX-071: globalSetup de jest-int.json y jest-e2e.json. Corre UNA vez en el
// proceso padre, antes de lanzar ningún fichero: si la base no es de test, la
// corrida entera se aborta sin que un solo spec llegue a importarse.
export default function globalSetupDbGuard(): void {
  loadTestEnvAndAssertDatabase();
}
