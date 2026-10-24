import type request from 'supertest';

type Assertable = {
  assert(
    error: Error | null,
    res: request.Response,
    done: (error: Error | null, res: request.Response) => void,
  ): void;
};

/**
 * Cuando una aserción de la petición falla (`.expect(201)` y compañía), añade
 * el cuerpo de la respuesta al mensaje: supertest solo dice «expected 201,
 * got 403», y es el `message`/`code` del cuerpo lo que distingue un guard de
 * otro. Sin efecto si la petición pasa.
 */
export function withBody<T extends request.Test>(req: T): T {
  const target = req as unknown as Assertable;
  const assert = target.assert.bind(req);
  target.assert = (error, res, done) =>
    assert(error, res, (e, r) => {
      if (e && r?.body && Object.keys(r.body as object).length > 0) {
        e.message = `${e.message}\nCuerpo: ${JSON.stringify(r.body)}`;
      }
      done(e, r);
    });
  return req;
}
