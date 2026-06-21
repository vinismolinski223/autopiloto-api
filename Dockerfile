FROM node:20-bullseye-slim

# Instala FFmpeg
RUN apt-get update && \
    apt-get install -y ffmpeg curl wget && \
    ffmpeg -version && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --production

COPY server.js ./

RUN mkdir -p /tmp/autopiloto

EXPOSE 3000

CMD ["node", "server.js"]
