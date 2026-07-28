# syntax=docker/dockerfile:1

# ---------- deps: production node_modules only ----------
FROM node:20-alpine AS deps

WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --omit=dev --ignore-scripts

# ---------- builder: full deps, compiled output ----------
FROM node:20-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json* .npmrc* ./
RUN npm ci --ignore-scripts

COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src

RUN npm run build

# ---------- runtime ----------
FROM node:20-alpine AS runtime

# tini reaps zombies and forwards SIGTERM, which node as PID 1 does not do.
# Without it graceful shutdown never fires and in-flight settlements are cut off.
RUN apk add --no-cache tini

ENV NODE_ENV=production \
    PORT=3003

WORKDIR /app

# Production dependencies come from `deps`, never from `builder`: shipping the
# build toolchain roughly triples the image and widens the CVE surface for code
# that never runs in production.
COPY --from=deps    --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/dist         ./dist
COPY --from=builder --chown=node:node /app/package.json ./

USER node

EXPOSE 3003

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.PORT||3003,path:'/health',timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "dist/main"]
