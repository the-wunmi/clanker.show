-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "template" TEXT,
    "status" TEXT DEFAULT 'idle',
    "listener_count" INTEGER DEFAULT 0,
    "idle_behavior" TEXT DEFAULT 'pause',
    "category" TEXT DEFAULT 'space',
    "max_speakers" INTEGER DEFAULT 1,
    "duration_min" INTEGER DEFAULT 60,
    "visibility" TEXT DEFAULT 'public',
    "created_by" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "space_hosts" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "space_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "style" REAL DEFAULT 0.5,
    "sort_order" INTEGER DEFAULT 0,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "space_hosts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "space_sources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "space_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'firecrawl_search',
    "query" TEXT NOT NULL,
    "sort_order" INTEGER DEFAULT 0,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "space_sources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "space_id" TEXT NOT NULL,
    "program_id" TEXT,
    "topic" TEXT,
    "audio_path" TEXT,
    "duration_ms" INTEGER,
    "source_url" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "segments_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
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
    "space_id" TEXT NOT NULL,
    "program_id" TEXT,
    "session_id" TEXT,
    "topic_hint" TEXT,
    "status" TEXT DEFAULT 'waiting',
    "accepted_at" DATETIME,
    "ended_at" DATETIME,
    "last_seen_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "call_queue_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE,
    CONSTRAINT "call_queue_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "call_queue_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "session_token" TEXT NOT NULL,
    "name" TEXT,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "space_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduled_at" DATETIME,
    "duration_min" INTEGER DEFAULT 60,
    "status" TEXT DEFAULT 'planning',
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    "updated_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "programs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
    "space_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "source_url" TEXT,
    "editor_name" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasoning" TEXT,
    "score" REAL,
    "created_at" DATETIME DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "editorial_decisions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "editorial_decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
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
CREATE UNIQUE INDEX "spaces_slug_key" ON "spaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "unsupported_scrape_domains_host_key" ON "unsupported_scrape_domains"("host");
