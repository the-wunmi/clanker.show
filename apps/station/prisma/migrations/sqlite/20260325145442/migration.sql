/*
  Warnings:

  - You are about to drop the column `caller_name` on the `call_queue` table. All the data in the column will be lost.

*/
-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_token" TEXT NOT NULL,
    "name" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_call_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "station_id" TEXT NOT NULL,
    "program_id" TEXT,
    "session_id" TEXT,
    "topic_hint" TEXT,
    "status" TEXT DEFAULT 'waiting',
    "accepted_at" DATETIME,
    "ended_at" DATETIME,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "call_queue_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "call_queue_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "call_queue_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_call_queue" ("accepted_at", "created_at", "ended_at", "id", "station_id", "status", "topic_hint") SELECT "accepted_at", "created_at", "ended_at", "id", "station_id", "status", "topic_hint" FROM "call_queue";
DROP TABLE "call_queue";
ALTER TABLE "new_call_queue" RENAME TO "call_queue";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");
