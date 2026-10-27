FROM node:22-alpine
WORKDIR /app
COPY package*.json ./
RUN apk add --no-cache python3 make g++ && npm install --omit=dev && apk del python3 make g++
COPY . .
ENV NODE_ENV=production DB_FILE=/data/nova.sqlite PORT=3000
VOLUME /data
EXPOSE 3000
CMD ["node","server.js"]
