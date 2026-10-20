import { minioTestConfig, s3AppEnv } from '../support/minio';

// Se importa ANTES que AppModule: ConfigModule lee el entorno al cargarse,
// así que STORAGE_DRIVER=s3 y las S3_* tienen que estar ya puestas. Jest da a
// cada fichero de test su propia copia de process.env.
const cfg = minioTestConfig();
if (cfg) Object.assign(process.env, s3AppEnv(cfg));
