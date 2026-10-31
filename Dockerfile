# syntax=docker/dockerfile:1
# DX-083: imagen de producción de la API (NestJS + Prisma). La misma imagen
# sirve la API (`node dist/main`, por defecto), el worker (`APP_ROLE=worker`),
# las migraciones (`npx prisma migrate deploy`, como job con DIRECT_URL), el
# seed de referencia (`npm run seed:prod`) y la purga de auditoría
# (`npm run audit:purge:prod`). Runbook: dentalix-docs/docs/operacion/despliegue.md.
#   docker build -t dentalix-api .

FROM node:22-bookworm-slim AS base
# Prisma necesita OpenSSL para elegir y cargar su motor (debian-openssl-3.0.x).
RUN apt-get update \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app

# --- build: con devDependencies (Nest CLI, TypeScript, country-state-city) ---
FROM base AS build
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
# Secretos OPCIONALES de build (no quedan en ninguna capa): un `.npmrc`
# (registro privado) y la CA de un proxy con inspección TLS, p. ej.
#   docker build --secret id=npmrc,src=$HOME/.npmrc --secret id=ca,src=ca.crt .
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=ca,target=/run/secrets/ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --no-audit --no-fund
COPY . .
RUN npx prisma generate \
 && npm run build \
 && npm run build:scripts \
 && test -f dist/main.js

# --- deps: solo dependencias de producción, con el cliente de Prisma ---
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/schema.prisma
RUN --mount=type=secret,id=npmrc,target=/root/.npmrc,required=false \
    --mount=type=secret,id=ca,target=/run/secrets/ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca npm_config_cafile=/run/secrets/ca; fi; \
    npm ci --omit=dev --no-audit --no-fund \
 && npx prisma generate \
 && npm cache clean --force

# --- runtime: sin devDependencies, sin .env, usuario sin privilegios ---
FROM base AS runtime
ENV NODE_ENV=production \
    PORT=3000
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json package-lock.json ./
# schema + migraciones: `prisma migrate deploy` corre desde esta imagen.
COPY prisma/schema.prisma ./prisma/schema.prisma
COPY prisma/migrations ./prisma/migrations
# Todo es del root y de solo lectura para `node`, que corre el proceso. Los
# ficheros van a S3 (STORAGE_DRIVER=disk no arranca en producción).
USER node
EXPOSE 3000
CMD ["node", "dist/main"]
