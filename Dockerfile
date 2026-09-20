FROM node:22-bookworm-slim

WORKDIR /app

# sharp 需要的基础运行库（bookworm-slim 已包含 libvips 所需的 glibc 与字体依赖，此处只补最小集）
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN npm ci

COPY . .
RUN npm run db:migrate && npm run db:seed && npm run build

ENV NODE_ENV=production \
    PORT=3000 \
    DATABASE_URL="file:./data/app.db" \
    UPLOAD_DIR=./data/uploads \
    BACKUP_DIR=./data/backup \
    TZ=Asia/Shanghai

VOLUME ["/app/apps/server/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
