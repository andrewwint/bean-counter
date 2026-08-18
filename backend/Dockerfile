# syntax=docker/dockerfile:1
#
# Builds and runs the compiled backend API for the Fargate service described in
# infra/lib/bean-counter-stack.ts. This file lives in backend/, but the build
# context must be the repo root — npm workspaces need the root lockfile and the
# sibling workspace manifests to resolve — so it is built as:
#
#   docker build -f backend/Dockerfile .
#
# (infra/lib/bean-counter-stack.ts uses ecs.ContainerImage.fromAsset with a
# `file` override, which does exactly this.)

FROM node:22-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci

COPY backend/tsconfig.json backend/tsconfig.build.json backend/
COPY backend/src backend/src
RUN npm run build --workspace backend

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN npm ci --omit=dev --workspace backend

COPY --from=builder /app/backend/dist backend/dist

USER node
EXPOSE 3000
CMD ["node", "backend/dist/index.js"]
