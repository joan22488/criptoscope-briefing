# CriptoScope — Sistema de Inteligencia Cripto Automatizado

Sistema que monitoriza el mercado cripto 24/7, genera análisis con IA (Claude) y publica automáticamente en Telegram y X. Incluye bot de comandos bajo demanda con análisis de fotos.

---

## Qué hace

| Cuándo | Qué publica |
|--------|-------------|
| 07:00 diario | ☕ Briefing matinal → Telegram + 1 tweet en X (si `X_API_KEY` configurado) |
| 07:00 | 🌅 Radar de apertura — sesgo del día y nivel clave 4H → Telegram |
| 11:00 | 📈 Pulso técnico — momentum 1H RSI/MACD → Telegram |
| 15:00 | ⚡ On-chain y derivados — funding rate, OI, posicionamiento → Telegram |
| 19:00 | 🌙 Cierre europeo — balance del día + nivel sesión asiática → Telegram |
| Cada 30 min | 🚨 Monitor de alertas de alto impacto |
| Cada 30 min | ✅ Verificación automática de resultados de señales |
| Lunes 08:00 | 📅 Macro de la semana → canal (ForexFactory JSON, eventos alto impacto) |
| Domingos 09:00 | 📅 Resumen semanal con estadísticas de señales |
| Lun 16:30 · Mar 10:00 · Mié 12:00 · Sáb 11:00 · Dom 18:00 | 📝 Pipeline editorial autónomo — tweet de crecimiento → borrador privado + X |
| Bajo demanda | 🤖 Bot de Telegram con comandos en cualquier momento |

---

## Arquitectura

```
src/
├── index.js          # Punto de entrada. Inicia crons + bot
├── pipeline.js       # Orquesta el briefing matinal
├── claude.js         # Genera el paquete diario con Claude
├── signals.js        # Análisis técnico top-down 1D→4H→1H→15m + derivados Binance
├── weekly.js         # Resumen semanal
├── alerts.js         # Monitor de eventos críticos
├── editorial.js      # Pipeline editorial autónomo (tweet diario X según guion semanal)
├── bot.js            # Bot de Telegram con comandos bajo demanda
├── coindesk.js       # Fuentes de datos (precios, noticias, scoring editorial)
├── twitter.js        # Tweets vía Nitter RSS (contexto para Claude)
├── reddit.js         # HackerNews señales de comunidad
├── calendar.js       # Calendario económico ForexFactory
├── tracker.js        # Backtesting y estadísticas de señales
├── notion.js         # Integración Notion (briefings + señales)
├── telegram.js       # Envío a Telegram con chunking automático
├── twitter-post.js   # Publicación en X (tweet único + threads para /hilo)
├── media.js          # Imágenes: charts de barras/línea, banner de portada X (1500x500)
├── prompts.js        # Voz editorial CriptoScope + plantillas JSON
└── output.js         # Guardado local de archivos
```

---

## Fuentes de datos

| Dato | Fuente | Coste |
|------|--------|-------|
| Precios BTC/ETH/SOL | CoinGecko API (Demo) | Gratis |
| Gainers/Losers 24h | CoinGecko API | Gratis |
| Dominancia BTC + market cap global | CoinGecko API | Gratis |
| Fear & Greed Index | alternative.me | Gratis |
| Velas 1D/4H/1H/15m | OKX API pública | Gratis |
| Funding rate + Open Interest | OKX API pública | Gratis |
| Liquidaciones 24h BTC/ETH/SOL | OKX API pública | Gratis |
| OI histórico + L/S ratio + taker ratio BTC/ETH | Binance Futures API pública | Gratis |
| Noticias cripto | CoinDesk RSS | Gratis |
| Tweets de cuentas clave | Nitter RSS (fallback múltiple) | Gratis |
| Señales de comunidad | Hacker News API | Gratis |
| Calendario económico | ForexFactory JSON | Gratis |

---

## Análisis técnico (signals.js)

**4 franjas horarias con ángulo diferente cada una:**

| Franja | Foco | Pregunta que responde |
|--------|------|-----------------------|
| 🌅 07:00 Radar de apertura | 4H macro + 1D tendencia | ¿Cuál es el sesgo del día y el nivel más importante? |
| 📈 11:00 Pulso técnico | 1H momentum RSI/MACD | ¿Se confirma el setup de apertura o se invalida? |
| ⚡ 15:00 On-chain y derivados | Funding rate + Open Interest | ¿El mercado está largo o corto en exceso? |
| 🌙 19:00 Cierre europeo | Rango del día + nivel 1D | ¿Cómo cierra y qué vigilar en la sesión asiática? |

**Metodología top-down:**
1. **1D** — filtra la tendencia macro
2. **4H** — confirma estructura (foco apertura y cierre)
3. **1H** — valida RSI/MACD (foco pulso técnico)
4. **15m** — gatillo de entrada

**Indicadores calculados por timeframe:**
- RSI 14 con zonas OB (>70) / OS (<30) / Reset (40-60)
- MACD 12/26/9: cruce, posición respecto a cero, dirección del histograma
- Divergencias RSI y MACD (ventana 10-20 velas)
- EMA 20 y EMA 50
- Niveles pivot (R1, R2, S1, S2) basados en últimas 20 velas 4H
- Funding rate perpetuos + Open Interest

**Pares:** BTC · ETH · SOL · AVAX · LINK · BNB · XRP (configurable con `SIGNALS_SYMBOLS`)

**Salida:** LONG / SHORT / ESPERAR con entrada, TP1, TP2, SL, R:R y tamaño (NORMAL / REDUCIDO si hay divergencia)

---

## Bot de Telegram

Escríbele directamente al bot (chat privado):

### Contenido manual — preview + botones antes de publicar
| Comando | Ejemplo | Resultado |
|---------|---------|-----------|
| `/flash <tema>` | `/flash BlackRock compra BTC` | Alerta urgente con preview y botones de destino |
| `/hilo <tema>` | `/hilo qué es el halving` | Thread 5 tweets — canal como mensaje único, X como thread encadenado |
| `/hilo <URL>` | `/hilo https://coindesk.com/...` | Hilo basado en el contenido real del artículo |
| `/analiza <coin>` | `/analiza AVAX` | Gráfico 4H + análisis técnico top-down con entrada, TP1, TP2, SL y R:R |
| `/opinion <noticia>` | `/opinion SEC aprueba ETF` | Lectura de mercado estilo CriptoScope |
| `/encuesta [tema]` | `/encuesta` · `/encuesta BTC esta semana` | Poll nativo para el canal con preview |
| `/semanal` | `/semanal` | Resumen semanal bajo demanda — sin esperar al domingo |
| `/publicar <texto>` | `/publicar BTC supera los 100k. Nivel clave: 98.000.` | Publica tu propio texto (+ foto opcional) en X y/o canal con 4 botones de destino |
| `/banner` | `/banner` | Genera imagen de portada 1500×500 px con datos del día lista para subir a X |

**Botones de publicación** (aparecen tras generar cualquier contenido):
- 📢 **Canal + X** — publica en Telegram y en X (con hashtags automáticos de monedas)
- 📣 **Solo canal** — solo Telegram
- 🐦 **Solo X** — solo Twitter/X
- 🟡 **Binance Square** — formatea el texto en plain text (sin HTML) listo para copiar-pegar en Binance Square
- 📊 **CMC Community** — ídem para CoinMarketCap Community
- 📸 **Añadir / Cambiar portada** — la foto se integra en el mismo mensaje del canal y se adjunta al tweet de X
- ❌ **Descartar** — no publica nada

> También puedes enviar una foto con el comando como pie de foto (`/flash tema` + foto adjunta) y la foto se usa automáticamente como portada.

### Solo te responden a ti
| Comando | Ejemplo | Resultado |
|---------|---------|-----------|
| `/precio <coin>` | `/precio BTC` | Precio + máx/mín/vol 24h |
| `/quepasa` | `/quepasa` | Resumen mercado ahora mismo |
| `/senal <coin>` | `/senal ETH` | Señal técnica privada (no publica en canal) |
| `/calendario` | `/calendario` | Eventos macro de la semana con hora exacta |
| `/alerta <coin> <precio>` | `/alerta BTC 70000` · `/alerta ETH <1800` | Aviso cuando llegue al nivel |
| `/alertas` | `/alertas` | Lista tus alertas activas |
| `/borralalerta <n>` | `/borralalerta 1` | Elimina la alerta número 1 |

### Publicaciones programadas
| Comando | Ejemplo | Resultado |
|---------|---------|-----------|
| `/programar <tipo> <HH:MM> <tema>` | `/programar flash 18:00 BlackRock` | Publica a esa hora (horario Madrid) |
| `/programadas` | `/programadas` | Lista de pendientes con IDs |
| `/cancelar <id>` | `/cancelar 3` | Cancela la publicación número 3 |

### Fotos sin comando
| Acción | Resultado |
|--------|-----------|
| Foto de noticia | Verificación de credibilidad (✅ VERIFICADA · 🟡 PROBABLE · ⚠️ DUDOSA · 🚫 FALSA) + análisis + botones para publicar |
| Foto + pie `responde` | Redacta una respuesta al comentario de la imagen (solo para ti) |

### Monitor automático de noticias
Cada 15 min el sistema revisa **6 fuentes RSS en paralelo**: CoinDesk · Cointelegraph · The Block · Decrypt · BeInCrypto · The Defiant. Si detecta una noticia con tus keywords (`MONITOR_KEYWORDS`) te la manda en privado con botones y una **puntuación editorial automática**:

| Puntuación | Emoji | Significado |
|-----------|-------|-------------|
| ≥ 6 pts | 🔥🔥🔥 | Viral para X — institucional + cifra + urgencia |
| ≥ 4 pts | 🔥🔥 | Buena para X |
| ≥ 2 pts | 🔥 | Canal Telegram |
| < 2 pts | ⬜ | Omitir |

Cuando una señal toca TP1, TP2 o SL, recibes una **alerta privada** con todos los detalles (entrada, niveles, R:R).
- **⚡ Flash** — genera flash con preview + botones de destino
- **📝 Hilo** — genera hilo de 5 tweets con preview + botones
- **🐦 Tweet X** — genera tweet nativo y publica **directamente en X** sin pasos intermedios (queda registrado en Notion)
- **🙈 Ignorar** — descarta la noticia

### Sistema
| Comando | Acción |
|---------|--------|
| `/estado` | Estado completo: hora Madrid, alertas activas, programadas y próximas ejecuciones automáticas |
| `/pausa` | Pausar todas las publicaciones automáticas |
| `/activa` | Reanudar publicaciones |
| `/cancelar_editorial` | Cancela el tweet editorial pendiente antes de que se publique en X |
| `/ayuda` | Guía completa. `/ayuda <comando>` para detalle de cada uno |

---

## Telegram Mini App (panel de administración)

Panel web embebido en Telegram para gestionar el bot sin escribir comandos:

- **Señales pendientes** — aprueba o descarta señales técnicas con un tap
- **Estado del bot** — activo/pausado, alertas activas, próximas ejecuciones
- **Portadas fijas** — fija o limpia la portada del briefing y del resumen semanal
- **Macro de la semana** — eventos macroeconómicos agrupados por día

**Stack:** React + Vite · Lucide React icons · Telegram WebApp SDK

**Despliegue:** Vercel (`miniapp/`) → `MINIAPP_URL=https://criptoscope-briefing.vercel.app`

**Registrar en BotFather:** `/newapp` → apunta a la URL de Vercel. Acceso desde el bot con el botón del menú.

---

## Variables de entorno

Copia `.env.example` a `.env` y rellena:

```env
# ─── OBLIGATORIAS ────────────────────────────────────────────
ANTHROPIC_API_KEY=sk-ant-...          # console.anthropic.com
TELEGRAM_BOT_TOKEN=123456:ABC...      # @BotFather en Telegram
TELEGRAM_CHAT_ID=-100...              # ID del canal (con -100 delante)

# ─── RECOMENDADAS ────────────────────────────────────────────
COINGECKO_API_KEY=CG-...              # coingecko.com/en/developers → Demo gratis
TELEGRAM_OWNER_ID=...                 # Tu chat ID personal → escríbele a @userinfobot
MONITOR_KEYWORDS=ETF,BlackRock,SEC,Fed,Bitcoin,halving,Ethereum,crash,Binance  # Keywords del monitor RSS
X_PROFILE_URL=https://x.com/tuusuario  # Aparece al pie de cada publicación del canal

# ─── X / TWITTER (opcional) ──────────────────────────────────
X_API_KEY=...                         # developer.twitter.com → OAuth 1.0a
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...

# ─── NOTION (opcional) ───────────────────────────────────────
NOTION_TOKEN=ntn_...                  # notion.so/my-integrations
NOTION_BRIEFINGS_DB=...               # ID de la base de datos de briefings
NOTION_SIGNALS_DB=...                 # ID de la base de datos de señales
NOTION_PUBLICACIONES_DB=...           # ID de la base de datos de publicaciones (log unificado)

# ─── SEÑALES (opcional) ───────────────────────────────────────
SIGNALS_SYMBOLS=BTC,ETH,SOL,AVAX,LINK,BNB,XRP  # Monedas en el análisis automático

# ─── INTEGRACIONES EXTERNAS (opcional) ───────────────────────
WEBHOOK_SECRET=criptoscope-tv         # Token para webhooks de TradingView
CRYPTOPANIC_TOKEN=...                 # cryptopanic.com → 7ª fuente RSS

# ─── CONFIGURACIÓN ────────────────────────────────────────────
CLAUDE_MODEL=claude-sonnet-4-6
TIMEZONE=Europe/Madrid
CRON_SCHEDULE=0 7 * * *
SIGNALS_SCHEDULE=0 7,11,15,19 * * *
WEEKLY_SCHEDULE=0 9 * * 0
ALERTS_SCHEDULE=*/30 * * * *
EDITORIAL_DELAY_MIN=10                # Minutos entre borrador y publicación en X (editorial autónomo)
```

---

## Instalación desde cero

### 1. Clonar y preparar

```bash
git clone <url-del-repo>
cd criptoscope-briefing
npm install
cp .env.example .env
# Rellenar .env con las credenciales
```

### 2. Crear el bot de Telegram

1. Habla con `@BotFather` en Telegram
2. `/newbot` → elige nombre y username
3. Copia el token → `TELEGRAM_BOT_TOKEN`
4. Crea un canal, añade el bot como administrador con permisos de publicar
5. Obtén el ID del canal: reenvía un mensaje del canal a `@userinfobot` → `TELEGRAM_CHAT_ID`

### 3. CoinGecko API key (gratuita)

1. Regístrate en [coingecko.com/en/developers](https://www.coingecko.com/en/developers)
2. Dashboard → API Keys → crear clave Demo
3. Copia la clave → `COINGECKO_API_KEY`
4. Plan Demo: 10.000 créditos/mes, 100 llamadas/min. El sistema usa ~64 créditos/mes.

### 4. X / Twitter (opcional)

1. [developer.twitter.com](https://developer.twitter.com) → crear proyecto + app
2. Permisos: Read and Write
3. Generar Consumer Key + Consumer Secret → `X_API_KEY` y `X_API_SECRET`
4. En la MISMA sesión, generar Access Token + Secret → `X_ACCESS_TOKEN` y `X_ACCESS_SECRET`
   ⚠️ Generar ambos pares en la misma sesión o devuelve error 401
5. Activar Pay Per Use en el portal ($5 de créditos inicial)

### 5. Notion (opcional)

1. [notion.so/my-integrations](https://www.notion.so/my-integrations) → Nueva integración
2. Copia el token → `NOTION_TOKEN`
3. Crea una página en Notion, añade la integración (Compartir → buscar la integración)
4. Crea dos bases de datos:

**Briefings Diarios:**

| Columna | Tipo |
|---------|------|
| Titular | Title |
| Fecha | Date |
| BTC Precio | Number |
| ETH Precio | Number |
| Fear & Greed | Number |
| Narrativa | Text |
| Pregunta Comunidad | Text |

**Señales Técnicas:**

| Columna | Tipo |
|---------|------|
| ID | Title |
| Symbol | Select |
| Operación | Select |
| Entrada | Number |
| TP1 | Number |
| TP2 | Number |
| SL | Number |
| R:R | Text |
| Precio Envío | Number |
| Fecha | Date |
| Resultado | Select (PENDIENTE / TP1 ✅ / TP2 ✅ / SL ❌ / EXPIRADO) |
| Resultado Fecha | Date |

**Publicaciones (log unificado):**

| Columna | Tipo |
|---------|------|
| Título | Title |
| Tipo | Select (Flash / Hilo / Análisis / Opinión / Semanal / Briefing / Otro) |
| Plataforma | Select (Canal / X / Canal+X) |
| Fecha | Date |
| Texto | Text |
| Portada | Checkbox |
| Estado | Select (Publicado / Error canal / Error X) |

5. Copia los IDs de las tres bases de datos desde la URL → `NOTION_BRIEFINGS_DB`, `NOTION_SIGNALS_DB` y `NOTION_PUBLICACIONES_DB`

### 6. Probar en local

```bash
# Probar el briefing completo
npm run once

# Probar solo señales técnicas
npm run signals

# Probar resumen semanal
npm run weekly

# Modo producción (crons activos + bot)
npm start
```

---

## Despliegue en Railway

```bash
# Instalar Railway CLI
npm install -g @railway/cli

# Login
railway login

# Vincular al proyecto (desde la carpeta del repo)
railway link

# Subir variables de entorno
railway variables set ANTHROPIC_API_KEY=sk-ant-...
railway variables set TELEGRAM_BOT_TOKEN=...
railway variables set TELEGRAM_CHAT_ID=...
railway variables set COINGECKO_API_KEY=...
railway variables set CLAUDE_MODEL=claude-sonnet-4-6
railway variables set TIMEZONE=Europe/Madrid
railway variables set TELEGRAM_CANAL_URL=https://t.me/tucanalaqui
# ... resto de opcionales

# Desplegar
railway up --service <nombre-servicio>
```

O conecta el repositorio de GitHub en el dashboard de Railway para despliegue automático en cada push.

**Configuración recomendada:**
- Region: Europe West
- Restart policy: On failure
- No necesita ningún puerto expuesto

---

## Notas técnicas

**Parser JSON robusto:** Claude a veces devuelve JSON con formato incorrecto. Todos los módulos usan dos capas: extrae desde el primer `{` hasta el último `}`, y si falla, extrae campo a campo con regex.

**Chunking de Telegram:** Los mensajes se dividen automáticamente respetando párrafos (`\n\n`), luego líneas (`\n`), y por caracteres como último recurso. Límite: 4000 caracteres por mensaje.

**OKX para klines:** Binance devuelve HTTP 451 (restricción geográfica) desde Railway para el endpoint de velas. Todos los datos de klines y funding/OI usan OKX, que no tiene restricciones geográficas. Las velas de OKX vienen newest-first y se invierten para cronológico.

**Backtesting automático:** Cada señal con entrada definida se registra en Notion o en `./data/signals.json`. Cada 30 minutos se verifica si tocó TP1, TP2 o SL. Las señales expiran a las 48h.

**Verificación de noticias:** Cuando se manda una foto al bot, Claude hace primero un análisis de credibilidad (VERIFICADA / PROBABLE / DUDOSA / FALSA). Las noticias FALSAS no se pueden publicar.

**SDK Notion v5:** La versión 5 del SDK eliminó `databases.query`. Se usa `notion.request()` directamente contra la REST API para las consultas.

**Pipeline editorial autónomo:** `editorial.js` genera un tweet por día según el tipo (lunes ETF, martes institucional, miércoles educativo, sábado histórico, domingo principal). Flujo: contexto → Claude → borrador al owner → `EDITORIAL_DELAY_MIN` minutos de espera → publica en X con imagen. Cancelable con `/cancelar_editorial`.

**Banner X (1500×500):** `generarBannerX()` en media.js construye el banner como SVG en memoria y lo convierte a PNG con Sharp. Si Sharp falla, cae a `generarChartBarras`. El resultado se envía como documento (sin compresión) para preservar la resolución.

**Binance Futures (gratis, sin key):** `getBinanceFutures()` en signals.js obtiene OI histórico 20h, globalLongShortAccountRatio y takerlongshortRatio. Se usa en briefing, alertas y pipeline editorial como contexto de derivados.

**Scoring de noticias:** `puntuarNoticia()` en coindesk.js asigna puntos por keywords institucionales (+3), cifras en dólares (+2), urgencia (+2), BTC/ETH (+1 c/u) y regulación (+1). Sin coste de API.

---

## Coste estimado mensual

| Servicio | Plan | Coste |
|----------|------|-------|
| Claude API | Pay per use | ~$3-8/mes |
| Railway | Hobby | $5/mes |
| CoinGecko | Demo (gratis) | $0 |
| X API | Pay Per Use | ~$1-2/mes |
| Notion | Free | $0 |
| Resto de APIs | Gratis | $0 |
| **Total** | | **~$9-15/mes** |
