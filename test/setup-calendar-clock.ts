import {
  FAKE_NOW_ENV,
  parseFakeNow,
  shiftedDate,
} from './support/calendar-clock';

// DX-495: con FAKE_NOW (job «fronteras de calendario» de la CI), cada fichero
// de test arranca con el reloj en esa hora. Sin FAKE_NOW no cambia nada.
const fakeNow = parseFakeNow(process.env[FAKE_NOW_ENV]);
if (fakeNow !== null) globalThis.Date = shiftedDate(Date, fakeNow - Date.now());
