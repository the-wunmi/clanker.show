-- CreateTable
CREATE TABLE "stations" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "template" TEXT,
    "status" TEXT DEFAULT 'idle',
    "listener_count" INTEGER DEFAULT 0,
    "idle_behavior" TEXT DEFAULT 'pause',
    "created_by" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "station_hosts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "station_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "style" REAL DEFAULT 0.5,
    "sort_order" INTEGER DEFAULT 0,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "station_hosts_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "station_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "station_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'firecrawl_search',
    "query" TEXT NOT NULL,
    "sort_order" INTEGER DEFAULT 0,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "station_sources_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "station_id" TEXT NOT NULL,
    "program_id" TEXT,
    "topic" TEXT,
    "audio_path" TEXT,
    "duration_ms" INTEGER,
    "source_url" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "segments_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "segments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "transcript_lines" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "segment_id" TEXT NOT NULL,
    "line_index" INTEGER NOT NULL,
    "host" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "emotion" TEXT DEFAULT 'neutral',
    "fact_check_status" TEXT DEFAULT 'pending',
    "fact_check_claim" TEXT,
    "fact_check_reasoning" TEXT,
    "fact_check_sources" TEXT,
    "disputed_original_text" TEXT,
    "spoken_at" DATETIME,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "transcript_lines_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "call_queue" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "station_id" TEXT NOT NULL,
    "caller_name" TEXT,
    "topic_hint" TEXT,
    "status" TEXT DEFAULT 'waiting',
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "call_queue_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "station_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduled_at" DATETIME,
    "duration_min" INTEGER DEFAULT 60,
    "status" TEXT DEFAULT 'planning',
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "programs_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "rundown_segments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "program_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" TEXT DEFAULT 'planned',
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "rundown_segments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "editorial_decisions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "program_id" TEXT,
    "station_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "source_url" TEXT,
    "editor_name" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasoning" TEXT,
    "score" REAL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_decisions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "editorial_decisions_station_id_fkey" FOREIGN KEY ("station_id") REFERENCES "stations" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "unsupported_scrape_domains" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "host" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE UNIQUE INDEX "stations_slug_key" ON "stations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "unsupported_scrape_domains_host_key" ON "unsupported_scrape_domains"("host");
