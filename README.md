# Delivery Tracker

App para:
- Ver en tiempo real dónde está cada repartidor (hasta 4).
- Cargar los pedidos/direcciones desde **Kommo**.
- Calcular la ruta más corta entre paradas (por distancia, sin tráfico).
- Mandarle al repartidor "tu siguiente pedido" con un botón directo a Google Maps.

## Estructura
```
delivery-tracker/
  backend/                  <- servidor Node.js (API + panel admin + PWA repartidor)
                                incluye Dockerfile listo para Easypanel
  docker-compose.yml         <- servicio principal "app" (esto es lo que usa Easypanel)
  docker-compose.osrm.yml    <- OSRM opcional (motor de rutas por calles reales)
  osrm-data/                 <- aquí van los datos de mapa para OSRM (opcional)
```

---

# Opción A: Desplegar en Easypanel (recomendado)

## 1. Sube el proyecto a un repo de Git (GitHub/GitLab)
Easypanel jala el código desde un repositorio. Sube esta carpeta tal cual
(el `Dockerfile` ya está en `backend/`).

## 2. Crea el servicio en Easypanel
1. En tu proyecto de Easypanel, **Create Service > App**.
2. Fuente: conecta tu repo de Git.
3. **Build**: tipo "Dockerfile", **Ruta de compilación** `backend` y
   **Archivo** `Dockerfile` (ahí está el `Dockerfile`, dentro de `backend/`).

   > ⚠️ **Error común**: si dejas la Ruta de compilación en `/` y el Archivo
   > en `docker-compose.yml`, Easypanel va a intentar compilar el
   > `docker-compose.yml` como si fuera un Dockerfile y falla con
   > `unknown instruction: version:`. Un `docker-compose.yml` **no es** un
   > Dockerfile — o usas el método "Dockerfile" apuntando a `backend/Dockerfile`
   > (este paso), o usas el tipo de servicio "App > Compose" con el
   > `docker-compose.yml` (ver paso 4 más abajo). No mezcles los dos.
4. **Puerto**: 3000 (Easypanel lo detecta o lo pones manual en "Ports").
5. **Dominio**: en la pestaña "Domains", agrega tu dominio o subdominio
   (ej. `reparto.tuempresa.com`) y activa HTTPS — Easypanel genera el
   certificado Let's Encrypt automáticamente, **no necesitas Nginx ni
   certbot manual**.
6. **Volumen persistente**: en "Mounts" agrega un volumen montado en
   `/app/data` (ahí vive la base SQLite). Esto es importante — si no,
   pierdes los datos cada vez que Easypanel reconstruye el contenedor.

## 3. Variables de entorno
En la pestaña **Environment** del servicio, agrega:
```
ADMIN_PASSWORD=cambia_esta_clave
KOMMO_SUBDOMAIN=tuempresa
KOMMO_ACCESS_TOKEN=tu_token_de_kommo
KOMMO_ADDRESS_FIELD_ID=123456
KOMMO_LATLNG_FIELD_ID=
KOMMO_STATUS_ID=
NOMINATIM_URL=https://nominatim.openstreetmap.org
NOMINATIM_USER_AGENT=mi-delivery-tracker (contacto@tuempresa.com)
OSRM_URL=http://localhost:5000
```
(`PORT` y `SQLITE_PATH` ya vienen fijos en el `Dockerfile`/`docker-compose.yml`,
no hace falta tocarlos). Ver la sección **"Configurar Kommo"** más abajo para
saber cómo sacar `KOMMO_ADDRESS_FIELD_ID` y `KOMMO_STATUS_ID`.

Guarda y haz **Deploy**. Con eso ya tienes `https://reparto.tuempresa.com/admin`
y `https://reparto.tuempresa.com/driver` funcionando con HTTPS.

## 4. Alternativa: pegar el docker-compose.yml directo
Si prefieres usar el tipo de servicio **"App > Compose"** de Easypanel en vez
de conectar un repo, puedes pegar el contenido de `docker-compose.yml` ahí
directamente (Easypanel se encarga de exponer el dominio/HTTPS igual).

## 5. Crear repartidores
Usa la pestaña **"Terminal"** de Easypanel (te da una consola dentro del
contenedor) o simplemente corre esto desde tu computadora, apuntando a tu
dominio ya público:
```bash
curl -X POST https://reparto.tuempresa.com/api/admin/drivers \
  -H "Content-Type: application/json" \
  -H "x-admin-password: TU_ADMIN_PASSWORD" \
  -d '{"name":"Juan", "login_code":"juan123"}'
```
Repite por cada repartidor (máximo recomendado: 4, aunque soporta más).

## 6. Motor de rutas real (OSRM) — opcional
Por defecto el sistema calcula rutas con distancia en línea recta (rápido,
sin configurar nada). Si más adelante quieres que respete calles reales:

1. Prepara los datos del mapa (una sola vez, en tu computadora o en el VPS):
   ```bash
   mkdir osrm-data && cd osrm-data
   wget https://download.geofabrik.de/north-america/mexico-latest.osm.pbf
   docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-extract -p /opt/car.lua /data/mexico-latest.osm.pbf
   docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-partition /data/mexico-latest.osrm
   docker run -t -v "${PWD}:/data" osrm/osrm-backend osrm-customize /data/mexico-latest.osrm
   # renombra los archivos generados para que empiecen con "map.osrm"
   ```
2. En Easypanel, crea **otro servicio** tipo "App > Compose", pega el
   contenido de `docker-compose.osrm.yml`, y sube/monta la carpeta
   `osrm-data/` ya procesada.
3. En el servicio "app", cambia la variable `OSRM_URL` a la URL interna
   del servicio OSRM que te da Easypanel (normalmente
   `http://<nombre-del-servicio>:5000` si están en el mismo proyecto).
4. Redeploy el servicio "app".

Si OSRM no responde (no lo configuraste o se cae), el sistema usa el
respaldo de línea recta automáticamente — nada se rompe.

---

# Opción B: VPS manual (sin Easypanel)

## 1. Requisitos
- Node.js 18+ · Docker (solo si usas OSRM) · dominio apuntando al VPS
- Nginx + certbot para HTTPS (obligatorio: la geolocalización del celular
  NO funciona sin HTTPS)

## 2. Instalar y correr
```bash
cd backend
npm install
cp .env.example .env    # edita con tus datos
npm start
```

## 3. Nginx + HTTPS
```nginx
server {
    listen 80;
    server_name reparto.tuempresa.com;
    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
    }
}
```
```bash
sudo certbot --nginx -d reparto.tuempresa.com
```

## 4. Mantener el proceso vivo
```bash
npm install -g pm2
cd backend
pm2 start src/server.js --name delivery-tracker
pm2 save
pm2 startup
```

---

## Configurar Kommo
1. En Kommo, ve a **Ajustes > Integraciones > API** y genera un **token de
   larga duración** (long-lived token). Es tu `KOMMO_ACCESS_TOKEN`.
2. Tu subdominio de Kommo (la parte antes de `.kommo.com`) es
   `KOMMO_SUBDOMAIN`.
3. Necesitas el **ID del campo personalizado** donde guardas la dirección
   de entrega:
   ```bash
   curl -H "Authorization: Bearer TU_TOKEN" \
     https://tuempresa.kommo.com/api/v4/leads/custom_fields
   ```
   Busca el campo de dirección y copia su `"id"` a `KOMMO_ADDRESS_FIELD_ID`.
4. (Opcional) Si quieres sincronizar solo los leads en un estado/pipeline
   específico ("listo para entregar"):
   ```bash
   curl -H "Authorization: Bearer TU_TOKEN" \
     https://tuempresa.kommo.com/api/v4/leads/pipelines
   ```
   pon ese `status_id` en `KOMMO_STATUS_ID`. Si lo dejas vacío, se
   sincronizan todos los leads abiertos.

Cada clic en "Sincronizar pedidos desde Kommo" en el panel trae los leads,
geocodifica la dirección (si no tienes lat/lng directo) y los agrega como
pedidos pendientes.

---

## Cómo se usa día a día
1. El repartidor abre `https://reparto.tuempresa.com/driver` en su celular,
   entra con su código, y **deja la pestaña abierta** (idealmente instalada
   como app: en Chrome Android, menú > "Instalar app"). Esto manda su
   ubicación cada vez que el GPS detecta movimiento.
2. Tú abres `https://reparto.tuempresa.com/admin` con tu contraseña, ves a
   los repartidores en el mapa en tiempo real.
3. Le das clic a "Sincronizar pedidos desde Kommo" para traer los pedidos
   nuevos.
4. Marcas qué pedidos van con qué repartidor, clic en "Optimizar ruta y
   asignar" — el sistema calcula el orden más corto empezando desde donde
   está el repartidor ahora mismo.
5. Al repartidor le aparece automáticamente "tu siguiente parada" con
   botón directo a Google Maps. Cuando entrega, toca "Marcar como
   entregado" y le aparece la siguiente.

## Limitación importante sobre "segundo plano"
Ningún navegador (Chrome, Safari) garantiza mandar ubicación si el
celular tiene la pantalla **apagada** y la app **totalmente cerrada** —
esto es una restricción de Android/iOS para ahorrar batería, no de esta
app ni de Easypanel. Lo que sí funciona de forma confiable:
- La pestaña/PWA abierta en segundo plano (otra app encima, pantalla
  prendida): sigue mandando ubicación.
- Instalada como PWA en la pantalla de inicio: se comporta más como app
  nativa y Android le da más prioridad.
- Si necesitas 100% background con pantalla apagada, la única solución
  robusta es una app nativa (Android/iOS) — un proyecto aparte, bastante
  más grande. Lo dejo apuntado por si en el futuro crece la operación.
