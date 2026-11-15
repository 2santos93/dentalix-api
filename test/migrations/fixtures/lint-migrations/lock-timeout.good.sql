-- lock_timeout antes del primer DDL; la tabla nueva no lo necesitaría.
SET LOCAL lock_timeout = '5s';
CREATE TABLE "chair_colors" ("id" UUID PRIMARY KEY, "name" TEXT NOT NULL);
ALTER TABLE "chair_colors" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chairs" ADD COLUMN "colorId" UUID;
