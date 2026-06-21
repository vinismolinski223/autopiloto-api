FROM node:20-bullseye-slim
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
RUN npm install --production
COPY server.js ./
COPY public ./public
RUN mkdir -p /tmp/autopiloto
EXPOSE 3000
CMD ["node", "server.js"]
