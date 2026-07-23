FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/ .

# Aqui vivira la base de datos SQLite (se monta como volumen persistente en Easypanel)
RUN mkdir -p /app/data
ENV SQLITE_PATH=/app/data/data.sqlite

EXPOSE 3000

CMD ["node", "src/server.js"]
