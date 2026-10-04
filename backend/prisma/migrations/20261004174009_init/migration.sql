-- CreateEnum
CREATE TYPE "TableStatus" AS ENUM ('free', 'occupied');

-- CreateEnum
CREATE TYPE "ClientSessionStatus" AS ENUM ('active', 'expired', 'left', 'kicked_by_staff');

-- CreateTable
CREATE TABLE "tables" (
    "id" SERIAL NOT NULL,
    "number" INTEGER NOT NULL,
    "qr_token_secret" TEXT NOT NULL,
    "status" "TableStatus" NOT NULL DEFAULT 'free',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tables_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_sessions" (
    "id" SERIAL NOT NULL,
    "table_id" INTEGER NOT NULL,
    "pseudo" TEXT NOT NULL,
    "push_token" TEXT,
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMP(3),
    "status" "ClientSessionStatus" NOT NULL DEFAULT 'active',

    CONSTRAINT "client_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tables_number_key" ON "tables"("number");

-- CreateIndex
CREATE UNIQUE INDEX "tables_qr_token_secret_key" ON "tables"("qr_token_secret");

-- AddForeignKey
ALTER TABLE "client_sessions" ADD CONSTRAINT "client_sessions_table_id_fkey" FOREIGN KEY ("table_id") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
