FROM python:3.11-slim

RUN apt-get update && apt-get install -y \
    ffmpeg \
    nodejs \
    npm \
    curl \
    wget \
    && rm -rf /var/lib/apt/lists/*

RUN pip install openai-whisper yt-dlp --break-system-packages

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./
COPY public ./public

RUN mkdir -p /tmp/clipforge

EXPOSE 3000

CMD ["node", "server.js"]
