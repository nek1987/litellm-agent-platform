# syntax=docker/dockerfile:1.7

# ---------- 1. install ----------
FROM node:20-alpine AS deps
WORKDIR /app

# Only copy lockfiles first so `npm ci` is cached unless deps change.
COPY package.json package-lock.json ./
RUN npm ci

# ---------- 2. build ----------
FROM node:20-alpine AS builder
WORKDIR /app

# Prisma needs openssl at codegen time on alpine.
RUN apk add --no-cache openssl

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Generate the Prisma client before next build — types like Prisma.AgentUpdateInput
# are required by app code.
RUN npx prisma generate

# `output: "standalone"` in next.config.ts emits .next/standalone with a
# minimal node_modules — that's what the runtime stage runs.
RUN npm run build

# ---------- 3. prisma migrate (compose init container) ----------
# `docker-compose.yml`'s db-migrate service builds this stage and runs it once
# at startup against the postgres service before web + worker come up.
FROM node:20-alpine AS prisma
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY prisma ./prisma
CMD ["npx", "prisma", "db", "push", "--accept-data-loss", "--skip-generate"]

# ---------- 4. worker (reconciler) ----------
# Reuses `builder` (full node_modules, full source) so `tsx` and the
# generated Prisma client are available at runtime.
FROM node:20-alpine AS worker
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json /app/package-lock.json /app/tsconfig.json ./
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/src/server ./src/server
COPY --from=builder /app/src/worker ./src/worker
CMD ["npx", "tsx", "src/worker/index.ts"]

# ---------- 5. run (web — default target) ----------
# Last stage = default `docker build` target = web service.
FROM node:20-alpine AS runner
WORKDIR /app

# Prisma needs openssl at runtime for `prisma db push`.
RUN apk add --no-cache openssl

ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1

# Run as non-root.
RUN addgroup --system --gid 1001 nodejs \
 && adduser  --system --uid 1001 nextjs

COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# Include the Prisma CLI + generated client + schema so the entrypoint can
# run `prisma db push` against $DATABASE_URL on startup. In docker-compose
# the db-migrate init container does this first; the second push is a no-op.
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/@prisma ./node_modules/@prisma
COPY --from=builder --chown=nextjs:nodejs /app/node_modules/prisma ./node_modules/prisma
COPY --from=builder --chown=nextjs:nodejs /app/prisma ./prisma
COPY --from=builder --chown=nextjs:nodejs /app/package.json ./package.json

USER nextjs
EXPOSE 3000

# Push schema, then start the standalone Next.js server (server.js is what
# `output: "standalone"` writes — equivalent to `next start` without the
# dev/test toolchain).
CMD ["sh", "-c", "node node_modules/prisma/build/index.js db push --accept-data-loss --skip-generate && node server.js"]
