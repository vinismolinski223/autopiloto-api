FROM node:20-slim

# Instala FFmpeg e ferramentas necessárias
RUN apt-get update && apt-get install -y \
    ffmpeg \
    ffprobe \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copia dependências
COPY package.json ./
RUN npm install --production

# Copia código
COPY server.js ./

# Cria pasta temp
RUN mkdir -p /tmp/autopiloto

EXPOSE 3000

CMD ["node", "server.js"]
