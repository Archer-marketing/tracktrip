# Delivery Tracker

App para:
- Ver en tiempo real dónde está cada repartidor (hasta 4).
- Cargar los pedidos/direcciones desde **Kommo**.
- Calcular la ruta más corta entre paradas (por distancia, sin tráfico).
- Mandarle al repartidor "tu siguiente pedido" con un botón directo a Google Maps.

## Estructura
```
delivery-tracker/
  Dockerfile                 <- Dockerfile en la raiz, listo para Easypanel
                                (metodo de build "Dockerfile", sin tocar
                                Ruta de compilacion / Archivo)
  backend/                  <- servidor Node.js (API + panel admin + PWA repartidor)
                                incluye su propio Dockerfile (usado por
                                docker-compose.yml para desarrollo local)
  docker-compose.yml         <- servicio principal "app" (para correrlo tu
                                mismo o pegarlo en Easypanel como "App > Compose")
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
3. **Build**: tipo "Dockerfile", **Ruta de compilación** `/` y
   **Archivo** `Dockerfile` (son los valores por default — hay un
   `Dockerfile` en la raíz del repo, no hace falta escribir `backend/nada`).

   > ⚠️ **Error común**: si el Archivo dice `docker-compose.yml`, Easypanel
   > va a intentar compilar ese archivo como si fuera un Dockerfile y falla
   > con `unknown instruction: version:`. Un `docker-compose.yml` **no es**
   > un Dockerfile — o usas el método "Dockerfile" apuntando al `Dockerfile`
   > de la raíz (este paso), o usas el tipo de servicio "App > Compose" con
   > el `docker-compose.yml` (ver paso 4 más abajo). No mezcles los dos.
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
KOMMO_TRACKING_FIELD_ID=2445646
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
Entra a `/admin`, en la sección **"Repartidores"** pon el nombre y un
código de acceso (lo que el repartidor va a usar para entrar a
`/driver`, ej. `juan123`) y dale "➕ Agregar repartidor". Repite por
cada repartidor (máximo recomendado: 4, aunque soporta más).

Cada repartidor tiene un botón **"🚫 Desactivar" / "✅ Activar"**: si lo
desactivas, su código deja de funcionar en `/driver` al instante (sin
borrar su historial de entregas), y tampoco aparece como opción al
asignar rutas.

Alternativa por curl, si lo prefieres:
```bash
curl -X POST https://reparto.tuempresa.com/api/admin/drivers \
  -H "Content-Type: application/json" \
  -H "x-admin-password: TU_ADMIN_PASSWORD" \
  -d '{"name":"Juan", "login_code":"juan123"}'
```

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
3. Configura `KOMMO_ACCESS_TOKEN` y `KOMMO_SUBDOMAIN` en Easypanel y haz
   deploy. Con eso ya puedes entrar al panel (`/admin`) y usar los
   selectores en vez de sacar IDs a mano con curl:
   - **"Kommo: embudo y etapa"** — elige en qué embudo/etapa están los
     pedidos listos para entregar (opcional, si no eliges nada sincroniza
     todos los leads abiertos).
   - **"Kommo: campo (dirección o liga de Maps)"** — elige cuál de tus
     campos personalizados de lead trae la ubicación de entrega. Sirve el
     mismo campo sea lo que sea que tengas ahí: dirección en texto, un
     link completo de Google Maps, uno acortado (`maps.app.goo.gl/...`),
     o `"lat,lng"` plano — el sistema detecta automáticamente cuál es y
     saca las coordenadas (o geocodifica si es texto de dirección). Se
     guarda solo al elegirlo, no hace falta darle a ningún botón.
   - **"Kommo: campo de factura (opcional)"** — si tienes un campo con la
     factura del pedido (una liga a un PDF/imagen, o solo un número de
     factura en texto), elígelo aquí. Se le va a mostrar al repartidor
     junto con esa parada — como botón "🧾 Ver factura" si es una liga,
     o como texto si no.

Cada clic en "Sincronizar pedidos desde Kommo" en el panel trae los leads,
geocodifica la dirección (si no tienes lat/lng directo) y los agrega como
pedidos pendientes. Si cambias el embudo/etapa (o un lead ya no aparece
en Kommo con ese filtro), los pendientes que ya no correspondan se
quitan solos en el siguiente sync — no se acumulan. Esto solo aplica a
pendientes sin asignar; un pedido ya asignado a un repartidor o ya
entregado nunca se toca.

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
4. Marcas qué pedidos van con qué repartidor. Por defecto la ruta empieza
   desde donde está el repartidor ahora mismo y termina donde sea más
   corto — pero puedes cambiar eso con **"Punto de partida"** y **"Punto
   final"**: elige un cliente ya cargado, o "Elegir en el mapa" y haz
   clic donde quieras (por ejemplo, la bodega).
   Clic en **"🔍 Vista previa de ruta"** — el mapa te muestra el orden
   propuesto con números (1, 2, 3...) para que revises que tenga sentido
   antes de confirmar. Si te convence, dale **"✅ Confirmar y asignar"**.
   En cuanto confirmas, se abre una **pestaña nueva con el nombre de ese
   repartidor** arriba de la lista de pedidos — ahí ves solo su ruta
   (numerada, con el color de ese repartidor), separada de las de los
   demás. La pestaña "📋 Pendientes" sigue siendo donde seleccionas
   pedidos para armar la siguiente ruta. Los entregados el día de hoy
   aparecen marcados con ✅ dentro de la pestaña de su repartidor.
5. Al repartidor le aparece automáticamente "tu siguiente parada" con
   botón directo a Google Maps. Cuando entrega, toca "Marcar como
   entregado" y le aparece la siguiente. Si quiere ver todo su recorrido
   (por ejemplo si un cliente no está y prefiere ver qué más le falta),
   puede tocar "🗺️ Ver ruta completa" — mapa y lista con todas sus
   paradas del día, marcando cuáles ya entregó.
6. Al confirmar la ruta (paso 4), cada pedido recién asignado recibe una
   **liga pública de rastreo** (`https://tudominio.com/track/<token>`),
   única por pedido y válida 24 horas. Ahí el cliente ve el mapa con su
   repartidor en tiempo real y cuántos pedidos le faltan para llegar al
   suyo — sin contraseña, pensada para compartirse directo con él. Esa
   misma liga se escribe automáticamente en el campo personalizado
   `KOMMO_TRACKING_FIELD_ID` del lead en Kommo (respetando el límite de
   7 solicitudes/segundo de Kommo). Por ahora solo se escribe el campo —
   no se manda nada al cliente automáticamente (WhatsApp/SMS), eso queda
   para una automatización futura.

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
