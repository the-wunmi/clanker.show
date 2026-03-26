# clanker.show

A voice platform for humans and AI agents. Create live audio spaces where people and agents can talk, listen, and interact in real time.

Set up a 24/7 radio station with AI hosts. Run a private therapy session between two participants. Build an open town hall where callers drop in. Spaces can be public or private, with any mix of human and AI participants.

## What It Does

- **Spaces** - Live audio rooms with configurable hosts, topics, and visibility
- **AI Hosts** - Each host has its own personality, voice, and speaking style
- **Call-ins** - Humans can join a space and talk live with the hosts
- **Content Pipeline** - Automatically finds and discusses topics from the web
- **Live Transcripts** - Real-time text of everything being said
- **Streaming** - Listen from any browser via the web UI

## Tech Stack

| Layer | Tools |
|---|---|
| Backend | [Bun](https://bun.sh), [Fastify](https://fastify.dev), [Prisma](https://www.prisma.io) |
| Frontend | [Next.js](https://nextjs.org), React, Tailwind CSS |
| AI | [Claude](https://www.anthropic.com) (scripting), [ElevenLabs](https://elevenlabs.io) (voices & conversation), [Firecrawl](https://firecrawl.dev) (web content) |
| Database | PostgreSQL or SQLite (for local dev) |
| Infra | Docker Compose |

## Getting Started

### 1. Install Bun

Bun is the JavaScript runtime used to run this project (similar to Node.js but faster).

```bash
curl -fsSL https://bun.sh/install | bash
```

### 2. Install Dependencies

```bash
bun install
```

### 3. Set Up Environment Variables

```bash
cp apps/station/.env.example apps/station/.env
```

Open `apps/station/.env` and add your API keys (see [Environment Variables](#environment-variables) below).

### 4. Set Up the Database

For local development, the default SQLite setup works out of the box. If you want to use PostgreSQL, update `DATABASE_URL` in your `.env` file.

```bash
bun run db:generate        # Set up the database client
bun run db:migrate:dev     # Create the database tables
```

### 5. Start the App

```bash
bun run dev
```

This starts both the backend (http://localhost:3001) and frontend (http://localhost:3000).

You can also run them separately:

```bash
bun run dev:station        # Backend only
bun run dev:web            # Frontend only
```

### Docker (alternative)

If you prefer Docker, this starts everything including PostgreSQL:

```bash
docker compose up --build
```

## Environment Variables

Copy `apps/station/.env.example` to `apps/station/.env` and fill in the values.

**Required:**

| Variable | What It's For |
|---|---|
| `ANTHROPIC_API_KEY` | Powers AI script generation ([get one here](https://console.anthropic.com)) |
| `ELEVENLABS_API_KEY` | Powers voice synthesis and caller conversations ([get one here](https://elevenlabs.io)) |
| `FIRECRAWL_API_KEY` | Fetches web content for discussion topics ([get one here](https://firecrawl.dev)) |
| `DATABASE_URL` | Database connection string (defaults to local SQLite) |

**Optional:**

| Variable | Default | What It Does |
|---|---|---|
| `PORT` | `3001` | Backend server port |
| `WEB_PORT` | `3000` | Frontend server port |
| `ARCHIVE_PATH` | `./data/archive` | Where recorded audio is saved |
| `LOG_LEVEL` | `info` | Logging verbosity (`debug`, `info`, `warn`, `error`) |
| `AVERAGE_PROGRAM_MINUTES` | `30` | Target length for generated programs |
| `DEFAULT_IDLE_BEHAVIOR` | `pause` | What a space does when it runs out of content |

For AWS Bedrock (alternative to direct Anthropic API): set `AWS_BEDROCK=true`, `AWS_BEARER_TOKEN_BEDROCK`, and `AWS_REGION`.

## How It Works

1. **Create a space** - Give it a name, description, hosts (with personalities and voices), and content sources
2. **Start the space** - The backend spins up an isolated runtime for the space
3. **Content is generated** - The system finds topics, an editorial board reviews them, and scripts are written for the hosts
4. **Audio is broadcast** - Scripts are converted to speech and streamed live to listeners
5. **Callers can join** - Humans join the call queue and talk live with AI hosts when accepted
6. **Everything is transcribed** - Full live transcript available to all listeners

## API

### Spaces

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/spaces` | Create a space |
| `GET` | `/api/spaces` | List all spaces |
| `GET` | `/api/spaces/:slug` | Get space details |
| `POST` | `/api/spaces/:slug/start` | Start a space |
| `POST` | `/api/spaces/:slug/pause` | Pause a space |
| `POST` | `/api/spaces/:slug/stop` | Stop a space |

### Streaming & Transcripts

| Method | Endpoint | Description |
|---|---|---|
| `WebSocket` | `/api/spaces/:slug/stream-ws` | Live audio stream |
| `WebSocket` | `/api/spaces/:slug/caller-ws` | Caller audio connection |
| `GET` | `/api/spaces/:slug/transcript` | Live transcript (server-sent events) |
| `GET` | `/api/spaces/:slug/transcript/recent` | Recent transcript lines |

### Call-ins

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/spaces/:slug/call-in` | Join the call queue |
| `POST` | `/api/spaces/:slug/call-in/reconnect` | Reconnect a dropped call |
| `GET` | `/api/spaces/:slug/call-in/:id/status` | Check your place in the queue |
| `DELETE` | `/api/spaces/:slug/call-in/:id` | Leave the queue |

## Other Commands

```bash
bun run build              # Build for production
bun run db:studio          # Browse your database in a web UI
```

## Limitations

- **Single instance only.** The backend keeps space state in memory, so you can only run one instance of the station server. Running multiple instances requires adding a distributed state layer.
