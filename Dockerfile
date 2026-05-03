FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production

# Build deps for better-sqlite3
FROM base AS deps
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ ca-certificates && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --include=dev

FROM deps AS build
COPY . .
RUN npm run build

FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/drizzle.config.ts ./drizzle.config.ts

EXPOSE 3000
# Run the Next.js server and the worker side-by-side. In Fly we'd use
# `processes` in fly.toml to split them; for the local image we use a single
# process group via npm-run-all (added on demand) or just run the worker
# as an alternate entrypoint.
CMD ["sh", "-c", "node node_modules/.bin/next start -p ${PORT:-3000} & exec node node_modules/.bin/tsx src/worker.ts"]
