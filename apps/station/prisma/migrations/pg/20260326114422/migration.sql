-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
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
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_hosts" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "personality" TEXT NOT NULL,
    "voice_id" TEXT NOT NULL,
    "agent_id" TEXT,
    "style" DOUBLE PRECISION DEFAULT 0.5,
    "sort_order" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_hosts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_sources" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'firecrawl_search',
    "query" TEXT NOT NULL,
    "sort_order" INTEGER DEFAULT 0,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "space_sources_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "program_id" TEXT,
    "topic" TEXT,
    "audio_path" TEXT,
    "duration_ms" INTEGER,
    "source_url" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transcript_lines" (
    "id" TEXT NOT NULL,
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
    "spoken_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "transcript_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "call_queue" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "program_id" TEXT,
    "session_id" TEXT,
    "topic_hint" TEXT,
    "status" TEXT DEFAULT 'waiting',
    "accepted_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "last_seen_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "call_queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "session_token" TEXT NOT NULL,
    "name" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "programs" (
    "id" TEXT NOT NULL,
    "space_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "scheduled_at" TIMESTAMP(3),
    "duration_min" INTEGER DEFAULT 60,
    "status" TEXT DEFAULT 'planning',
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "programs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rundown_segments" (
    "id" TEXT NOT NULL,
    "program_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "angle" TEXT NOT NULL,
    "estimated_minutes" INTEGER NOT NULL,
    "sort_order" INTEGER NOT NULL,
    "status" TEXT DEFAULT 'planned',
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rundown_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "editorial_decisions" (
    "id" TEXT NOT NULL,
    "program_id" TEXT,
    "space_id" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "source_url" TEXT,
    "editor_name" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "reasoning" TEXT,
    "score" DOUBLE PRECISION,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "editorial_decisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "unsupported_scrape_domains" (
    "id" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "reason" TEXT,
    "created_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "unsupported_scrape_domains_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "spaces_slug_key" ON "spaces"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "sessions_session_token_key" ON "sessions"("session_token");

-- CreateIndex
CREATE UNIQUE INDEX "unsupported_scrape_domains_host_key" ON "unsupported_scrape_domains"("host");

-- AddForeignKey
ALTER TABLE "space_hosts" ADD CONSTRAINT "space_hosts_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_sources" ADD CONSTRAINT "space_sources_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transcript_lines" ADD CONSTRAINT "transcript_lines_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_queue" ADD CONSTRAINT "call_queue_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_queue" ADD CONSTRAINT "call_queue_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "call_queue" ADD CONSTRAINT "call_queue_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "programs" ADD CONSTRAINT "programs_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rundown_segments" ADD CONSTRAINT "rundown_segments_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_decisions" ADD CONSTRAINT "editorial_decisions_program_id_fkey" FOREIGN KEY ("program_id") REFERENCES "programs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "editorial_decisions" ADD CONSTRAINT "editorial_decisions_space_id_fkey" FOREIGN KEY ("space_id") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
