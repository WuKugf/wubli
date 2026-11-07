FROM node:20-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .

# Hugging Face Spaces 默认把流量转发到 7860 端口；Render 会注入自己的 PORT 覆盖此值
ENV PORT=7860
EXPOSE 7860
CMD ["node", "server.js"]
