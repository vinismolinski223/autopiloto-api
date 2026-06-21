FROM node:20-bullseye-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    curl \
    wget \
    python3 \
    python3-pip \
    && rm -rf /var/lib/apt/lists/*

RUN pip3 install yt-dlp

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public

RUN mkdir -p /tmp/clipforge

EXPOSE 3000

CMD ["node", "server.js"]
