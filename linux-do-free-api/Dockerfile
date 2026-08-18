# 零依赖 Node 镜像（仅用运行时，不需要 npm install）
FROM node:20-alpine

WORKDIR /app

# 仅复制运行所需文件（号池数据通过 volume 挂载，不进镜像）
COPY package.json ./
COPY src ./src

# 预建数据目录并放开写权限，避免挂载卷前首次写入失败
RUN mkdir -p /app/data && chmod 777 /app/data

ENV HOST=0.0.0.0
ENV PORT=3090
ENV DATA_FILE=/app/data/accounts.json

# 号池数据持久化到挂载卷
VOLUME ["/app/data"]
EXPOSE 3090

# 轻量健康检查：探测 /health 端点（alpine 自带 wget）
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -q -O - http://127.0.0.1:3090/health || exit 1

CMD ["node", "src/index.js"]
