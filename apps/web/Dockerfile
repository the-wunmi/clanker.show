FROM oven/bun:1 AS base
WORKDIR /app

FROM base AS deps
COPY package.json bun.lock ./
COPY apps/web/package.json apps/web/package.json
COPY apps/station/package.json apps/station/package.json
RUN bun install --frozen-lockfile

FROM deps AS build
COPY apps/web apps/web
COPY tsconfig.json tsconfig.json
ENV NEXT_TELEMETRY_DISABLED=1
ENV STATION_URL=http://station:3001
RUN cd apps/web && bun run build

FROM base AS runtime
WORKDIR /app/apps/web

COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static .next/static
COPY --from=build /app/apps/web/public public

ENV NEXT_TELEMETRY_DISABLED=1
EXPOSE 3000

CMD ["bun", "server.js"]
