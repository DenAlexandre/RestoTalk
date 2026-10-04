-- CreateEnum
CREATE TYPE "TableContactStatus" AS ENUM ('pending', 'accepted', 'refused');

-- CreateEnum
CREATE TYPE "MessageKind" AS ENUM ('predefined', 'freetext');

-- CreateTable
CREATE TABLE "table_contacts" (
    "id" SERIAL NOT NULL,
    "table_a_id" INTEGER NOT NULL,
    "table_b_id" INTEGER NOT NULL,
    "status" "TableContactStatus" NOT NULL DEFAULT 'pending',
    "requested_by_session_id" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "responded_at" TIMESTAMP(3),

    CONSTRAINT "table_contacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" SERIAL NOT NULL,
    "contact_id" INTEGER NOT NULL,
    "sender_session_id" INTEGER NOT NULL,
    "kind" "MessageKind" NOT NULL,
    "predefined_code" TEXT,
    "content" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "table_contacts" ADD CONSTRAINT "table_contacts_table_a_id_fkey" FOREIGN KEY ("table_a_id") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_contacts" ADD CONSTRAINT "table_contacts_table_b_id_fkey" FOREIGN KEY ("table_b_id") REFERENCES "tables"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "table_contacts" ADD CONSTRAINT "table_contacts_requested_by_session_id_fkey" FOREIGN KEY ("requested_by_session_id") REFERENCES "client_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "table_contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_sender_session_id_fkey" FOREIGN KEY ("sender_session_id") REFERENCES "client_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
