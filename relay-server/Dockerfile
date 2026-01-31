# ── Stage 1: Build ──────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build

# ── Stage 2: Runtime ────────────────────────────────────────
FROM node:20-slim AS runtime

RUN groupadd -r appuser && useradd -r -g appuser appuser

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY public/ ./public/

RUN chown -R appuser:appuser /app
USER appuser

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "const http=require('http');const r=http.request({hostname:'localhost',port:3000,path:'/healthz',timeout:2000},s=>{process.exit(s.statusCode===200?0:1)});r.on('error',()=>process.exit(1));r.end();"

CMD ["node", "dist/index.js"]
