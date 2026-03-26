FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/station/package.json apps/station/package.json
COPY apps/web/package.json apps/web/package.json
RUN bun install --frozen-lockfile --ignore-scripts

FROM deps AS generate
COPY apps/station/prisma apps/station/prisma
COPY apps/station/prisma.config.ts apps/station/prisma.config.ts
COPY apps/station/scripts apps/station/scripts
ENV DATABASE_URL=postgresql://placeholder:placeholder@localhost:5432/placeholder
RUN cd apps/station && bun run db:generate

FROM generate AS build
COPY apps/station apps/station
COPY tsconfig.json tsconfig.json
RUN cd apps/station && bun build src/index.ts --outdir dist --target node

FROM base AS runtime
WORKDIR /app

COPY --from=deps /app/node_modules node_modules
COPY --from=deps /app/apps/station/node_modules apps/station/node_modules
COPY --from=generate /app/apps/station/src/generated apps/station/src/generated
COPY --from=generate /app/apps/station/prisma apps/station/prisma
COPY --from=generate /app/apps/station/prisma.config.ts apps/station/prisma.config.ts
COPY --from=generate /app/apps/station/scripts apps/station/scripts
COPY --from=build /app/apps/station/dist apps/station/dist
COPY --from=build /app/apps/station/src apps/station/src
COPY --from=build /app/apps/station/package.json apps/station/package.json
COPY --from=build /app/apps/station/tsconfig.json apps/station/tsconfig.json

RUN mkdir -p /app/data/archive

WORKDIR /app/apps/station
EXPOSE 3001

CMD ["sh", "-c", "bun run db:migrate && bun run src/index.ts"]
