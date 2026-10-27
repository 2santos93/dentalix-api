import { INestApplication } from '@nestjs/common';
import { createServer, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import request from 'supertest';
import { App } from 'supertest/types';
import { createE2eApp } from './support/create-e2e-app';
import { createE2eApp as createFixtureApp } from './support/e2e-fixtures';
import { listenOnEphemeralPort } from './support/listening-app';

describe.each([
  ['configureApp', createE2eApp],
  ['fixtures', createFixtureApp],
] as const)('HTTP listener (%s)', (_name, createApp) => {
  let app: INestApplication<App>;
  let server: Server;

  afterEach(async () => {
    await app?.close();
  });

  it('reserves its IPv4 port before Supertest and releases it on Nest close', async () => {
    app = await createApp();
    server = app.getHttpServer() as Server;
    expect(server.listening).toBe(true);
    const address = server.address() as AddressInfo;
    expect(address.address).toBe('127.0.0.1');
    expect(address.family).toBe('IPv4');

    const competitor = createServer();
    try {
      const error = await new Promise<NodeJS.ErrnoException | undefined>(
        (resolve) => {
          competitor.once('error', resolve);
          competitor.listen(address.port, '127.0.0.1', () =>
            resolve(undefined),
          );
        },
      );
      expect(error?.code).toBe('EADDRINUSE');
      await request(server).get('/api/v1/health').expect(200);
      await request(server).get('/api/v1/health').expect(200);
      expect(server.address()).toEqual(address);
    } finally {
      if (competitor.listening) {
        await new Promise<void>((resolve) => competitor.close(() => resolve()));
      }
    }
    await app.close();
    expect(server.listening).toBe(false);
  });
  it('reuses the listener through the bounded HTTP agent helper', async () => {
    app = await createApp();
    server = app.getHttpServer() as Server;
    const address = server.address();
    const http = await listenOnEphemeralPort(app);
    try {
      await http.get('/api/v1/health').expect(200);
      expect(server.address()).toEqual(address);
    } finally {
      await http.close();
    }
    expect(server.listening).toBe(false);
  });
});
