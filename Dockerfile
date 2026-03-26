FROM oven/bun:1 AS base
WORKDIR /app

# Shared dependency installation
FROM base AS deps
COPY package.json bun.lock ./
COPY apps/station/package.json apps/station/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS station-generate
COPY apps/station/prisma apps/station/prisma
COPY apps/station/prisma.config.ts apps/station/prisma.config.ts
COPY apps/station/scripts apps/station/scripts
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN cd apps/station && bun run db:generate

FROM station-generate AS station-build
COPY apps/station apps/station
COPY tsconfig.json tsconfig.json
RUN cd apps/station && bun build src/index.ts --outdir dist --target node

FROM base AS station
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/station/node_modules apps/station/node_modules
COPY --from=station-generate /app/apps/station/src/generated apps/station/src/generated
COPY --from=station-generate /app/apps/station/prisma apps/station/prisma
COPY --from=station-generate /app/apps/station/prisma.config.ts apps/station/prisma.config.ts
COPY --from=station-generate /app/apps/station/scripts apps/station/scripts
COPY --from=station-build /app/apps/station/dist apps/station/dist
COPY --from=station-build /app/apps/station/src apps/station/src
COPY --from=station-build /app/apps/station/package.json apps/station/package.json
COPY --from=station-build /app/apps/station/tsconfig.json apps/station/tsconfig.json

RUN mkdir -p /app/data/archive

WORKDIR /app/apps/station
EXPOSE 3001

CMD ["sh", "-c", "bun run db:migrate && bun run src/index.ts"]


FROM deps AS web-build
COPY apps/web apps/web
COPY tsconfig.json tsconfig.json
ENV NEXT_TELEMETRY_DISABLED=1
ENV STATION_URL=http://station:3001
RUN cd apps/web && bun run build

FROM base AS web
WORKDIR /app

COPY --from=web-build /app/apps/web/.next/standalone ./
COPY --from=web-build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=web-build /app/apps/web/public ./apps/web/public

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000

CMD ["bun", "apps/web/server.js"]
