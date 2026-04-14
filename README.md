# 🚆 Rodalies Proxy — Guía de despliegue en Railway

Backend proxy que conecta la app de Rodalies con los datos GTFS-RT en tiempo real de Renfe.  
**Datos oficiales de Renfe Open Data · Licencia CC-BY 4.0 · Actualización cada 20 segundos**

---

## ¿Qué hace este servidor?

El navegador no puede llamar directamente a `gtfsrt.renfe.com` porque Renfe no permite peticiones desde páginas web (bloqueo CORS). Este servidor actúa de intermediario:

```
Tu navegador → Proxy Railway → gtfsrt.renfe.com (Renfe)
```

---

## Paso 1 — Instala Git y Node.js (si no los tienes)

- **Git**: https://git-scm.com/downloads
- **Node.js 18+**: https://nodejs.org (descarga la versión LTS)

Verifica la instalación abriendo una terminal:
```bash
node --version   # debe mostrar v18.x.x o superior
git --version
```

---

## Paso 2 — Sube el código a GitHub

1. Ve a https://github.com y crea una cuenta gratuita si no tienes
2. Pulsa **"New repository"**, ponle nombre (ej: `rodalies-proxy`), déjalo **Public** y pulsa **Create**
3. En tu ordenador, abre una terminal en la carpeta de este proyecto y ejecuta:

```bash
git init
git add .
git commit -m "Primer commit - Rodalies proxy"
git branch -M main
git remote add origin https://github.com/TU_USUARIO/rodalies-proxy.git
git push -u origin main
```

_(Reemplaza `TU_USUARIO` con tu usuario de GitHub)_

---

## Paso 3 — Despliega en Railway

1. Ve a https://railway.app y crea una cuenta (puedes entrar con GitHub)
2. Pulsa **"New Project"** → **"Deploy from GitHub repo"**
3. Selecciona el repositorio `rodalies-proxy`
4. Railway detectará automáticamente que es Node.js y lo desplegará
5. Cuando termine (1-2 minutos), Railway te dará una URL como:
   ```
   https://rodalies-proxy-production-xxxx.up.railway.app
   ```
6. ¡Listo! Esa es tu URL pública.

---

## Paso 4 — Prueba que funciona

Abre en el navegador:
```
https://tu-url.up.railway.app/api/health
```
Deberías ver: `{"status":"ok","timestamp":"..."}`

Prueba los horarios de Barcelona-Sants:
```
https://tu-url.up.railway.app/api/departures?stopId=79300
```

Y la app web completa:
```
https://tu-url.up.railway.app
```

---

## Paso 5 — Actualizar si cambias algo

Cada vez que modifiques archivos:
```bash
git add .
git commit -m "descripción del cambio"
git push
```
Railway redespliega automáticamente en 1-2 minutos.

---

## Endpoints disponibles

| Endpoint | Descripción |
|----------|-------------|
| `GET /` | App web completa |
| `GET /api/departures?stopId=79300` | Próximos trenes de una estación |
| `GET /api/stops?q=barcelona` | Buscar estaciones por nombre |
| `GET /api/alerts` | Incidencias activas del servicio |
| `GET /api/health` | Estado del servidor |

### Stop IDs principales
| Stop ID | Estación |
|---------|----------|
| 79300 | Barcelona-Sants |
| 79304 | Barcelona-Plaça de Catalunya |
| 79318 | L'Hospitalet de Llobregat |
| 78820 | Mataró |
| 79216 | Terrassa Estació del Nord |
| 79210 | Sabadell Centre |
| 72016 | Sitges |
| 79420 | Sant Vicenç de Calders |
| 79504 | Vic |
| 71000 | Girona |

---

## Desarrollo local

```bash
npm install
npm run dev
```
Abre http://localhost:3000

---

## Fuente de datos

- **GTFS-RT tiempo real**: https://gtfsrt.renfe.com/trip_updates.json
- **Portal Open Data**: https://data.renfe.com
- **Licencia**: Creative Commons Attribution 4.0 (CC-BY 4.0)
