#!/usr/bin/env bash
# DX-251: S3 de prueba (MinIO) para los tests de S3 de DX-084 en la CI.
#
# Imagen fijada por DIGEST: `minio/minio` dejó de poderse descargar de Docker
# Hub («pull access denied», TST-026) y quay.io/minio/minio tampoco publica ya
# las etiquetas. cgr.dev/chainguard/minio es MinIO compilado desde el código
# fuente (mismo API S3, mismo /minio/health/live, MINIO_ROOT_USER/PASSWORD),
# público y sin límite de descargas anónimas. Chainguard solo publica `latest`
# gratis: el digest es lo que fija la versión (RELEASE.2026-09-22T19-25-18Z).
# Para actualizarla: `docker buildx imagetools inspect cgr.dev/chainguard/minio:latest`
# y cambiar el digest aquí y en docker-compose.yml.
#
# Uso: start-test-s3.sh  (lee S3_TEST_ACCESS_KEY_ID / S3_TEST_SECRET_ACCESS_KEY
# del entorno; publica la API en el puerto de S3_TEST_ENDPOINT, 9000 por defecto).
set -euo pipefail

for var in S3_TEST_ACCESS_KEY_ID S3_TEST_SECRET_ACCESS_KEY; do
  if [ -z "${!var:-}" ]; then
    echo "::error title=S3 de prueba sin configurar::Falta ${var} en el entorno del job (ver env de ci.yml)."
    exit 1
  fi
done

IMAGE="${TEST_S3_IMAGE:-cgr.dev/chainguard/minio:latest@sha256:cff197fef764642223ef9f4444c903d51aee9b544a7be8bc007fef6b7b00d136}"
PORT="${S3_TEST_ENDPOINT:-}"
PORT="${PORT##*:}"
PORT="${PORT%%/*}"
PORT="${PORT:-9000}"

if ! docker pull "$IMAGE"; then
  echo "::error title=S3 de prueba no disponible::No se pudo descargar ${IMAGE} (registro inaccesible, imagen retirada o límite de descargas). Los tests de S3 (test/storage/s3-*) fallarán por esto; el resto de la suite sigue. Revisa el digest en .github/scripts/start-test-s3.sh."
  exit 1
fi

docker run -d --name minio -p "${PORT}:9000" \
  -e MINIO_ROOT_USER="$S3_TEST_ACCESS_KEY_ID" \
  -e MINIO_ROOT_PASSWORD="$S3_TEST_SECRET_ACCESS_KEY" \
  "$IMAGE" server /data

for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:${PORT}/minio/health/live" >/dev/null 2>&1; then
    echo "S3 de prueba listo en http://localhost:${PORT} (${IMAGE})"
    exit 0
  fi
  sleep 2
done
docker logs minio || true
echo "::error title=S3 de prueba no arranca::${IMAGE} no respondió en /minio/health/live en 60 s. Los tests de S3 fallarán por esto; el resto de la suite sigue."
exit 1
