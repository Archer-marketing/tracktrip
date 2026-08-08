FROM node:20-alpine

WORKDIR /app

# Zona horaria del negocio (Cancun/Quintana Roo, UTC-5 fijo, sin horario de
# verano). Sin esto, SQLite compara fechas en UTC y una entrega de la
# noche (hora local) cuenta como "de manana" para filtros como "entregado
# hoy" - por eso reaparecian entregas de ayer en el panel/celular.
RUN apk add --no-cache tzdata
ENV TZ=America/Cancun

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY . .

# Aqui vivira la base de datos SQLite (se monta como volumen persistente en Easypanel)
RUN mkdir -p /app/data
ENV SQLITE_PATH=/app/data/data.sqlite

EXPOSE 3000

CMD ["node", "src/server.js"]
