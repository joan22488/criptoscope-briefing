# CriptoScope — Sistema de Inteligencia Cripto Automatizado

Sistema que monitoriza el mercado cripto 24/7, genera análisis con IA (Claude) y publica automáticamente en Telegram y X. Incluye bot de comandos bajo demanda con análisis de fotos.

---

## Qué hace

| Cuándo | Qué publica |
|--------|-------------|
| 07:00 diario | ☕ Briefing matinal completo → Telegram + X |
| 07:00, 11:00, 15:00, 19:00 | 📊 Señales técnicas BTC/ETH/SOL → Telegram |
| Cada 30 min | 🚨 Monitor de alertas de alto impacto |
| Cada 30 min | ✅ Verificación automática de resultados de señales |
| Domingos 09:00 | 📅 Resumen semanal con estadísticas de señales |
| Bajo demanda | 🤖 Bot de Telegram con comandos en cualquier momento |

---

## Arquitectura

```
src/
├── index.js          # Punto de entrada. Inicia crons + bot
├── pipeline.js       # Orquesta el briefing matinal
├── claude.js         # Genera el paquete diario con Claude
├── signals.js        # Análisis técnico top-down 1D→4H→1H→15m
├── weekly.js         # Resumen semanal
├── alerts.js         # Monitor de eventos críticos
├── bot.js            # Bot de Telegram con comandos bajo demanda
├── coindesk.js       # Fuentes de datos (precios, noticias, derivados)
├── twitter.js        # Tweets vía Nitter RSS (contexto para Claude)
├── reddit.js         # HackerNews señales de comunidad
├── calendar.js       # Calendario económico ForexFactory
├── tracker.js        # Backtesting y estadísticas de señales
├── notion.js         # Integración Notion (briefings + señales)
├── telegram.js       # Envío a Telegram con chunking automático
├── twitter-post.js   # Publicación de threads en X
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
| Noticias cripto | CoinDesk RSS | Gratis |
| Tweets de cuentas clave | Nitter RSS (fallback múltiple) | Gratis |
| Señales de comunidad | Hacker News API | Gratis |
| Calendario económico | ForexFactory RSS | Gratis |

---

## Análisis técnico (signals.js)

**Metodología top-down:**
1. **1D** — filtra la tendencia macro
2. **4H** — confirma estructura
3. **1H** — valida RSI/MACD
4. **15m** — gatillo de entrada

**Indicadores calculados por timeframe:**
- RSI 14 con zonas OB (>70) / OS (<30) / Reset (40-60)
- MACD 12/26/9: cruce, posición respecto a cero, dirección del histograma
- Divergencias RSI y MACD (ventana 10-20 velas)
- EMA 20 y EMA 50
- Niveles pivot (R1, R2, S1, S2) basados en últimas 20 velas 4H
- Funding rate perpetuos

**Pares:** BTCUSDT · ETHUSDT · SOLUSDT (ampliable con `/analiza`)

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
| `/analiza <coin>` | `/analiza AVAX` | Análisis técnico top-down con entrada, TP1, TP2, SL y R:R |
| `/opinion <noticia>` | `/opinion SEC aprueba ETF` | Lectura de mercado estilo CriptoScope |
| `/encuesta [tema]` | `/encuesta` · `/encuesta BTC esta semana` | Poll nativo para el canal con preview |

**Botones de publicación** (aparecen tras generar cualquier contenido):
- 📢 **Canal + X** — publica en Telegram y en X (con hashtags automáticos de monedas)
- 📣 **Solo canal** — solo Telegram
- 🐦 **Solo X** — solo Twitter/X
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
Cada 15 min el sistema revisa CoinDesk RSS. Si detecta una noticia con tus keywords (`MONITOR_KEYWORDS`) te la manda en privado con botones: **⚡ Publicar flash** · **📝 Hacer hilo** · **🙈 Ignorar**.

### Sistema
| Comando | Acción |
|---------|--------|
| `/estado` | Estado completo: hora Madrid, alertas activas, programadas y próximas ejecuciones automáticas |
| `/pausa` | Pausar todas las publicaciones automáticas |
| `/activa` | Reanudar publicaciones |
| `/ayuda` | Guía completa. `/ayuda <comando>` para detalle de cada uno |

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

# ─── X / TWITTER (opcional) ──────────────────────────────────
X_API_KEY=...                         # developer.twitter.com → OAuth 1.0a
X_API_SECRET=...
X_ACCESS_TOKEN=...
X_ACCESS_SECRET=...

# ─── NOTION (opcional) ───────────────────────────────────────
NOTION_TOKEN=ntn_...                  # notion.so/my-integrations
NOTION_BRIEFINGS_DB=...               # ID de la base de datos de briefings
NOTION_SIGNALS_DB=...                 # ID de la base de datos de señales

# ─── CONFIGURACIÓN ────────────────────────────────────────────
CLAUDE_MODEL=claude-sonnet-4-6
TIMEZONE=Europe/Madrid
TELEGRAM_CANAL_URL=https://t.me/tucanalaqui
CRON_SCHEDULE=0 7 * * *
SIGNALS_SCHEDULE=0 7,11,15,19 * * *
WEEKLY_SCHEDULE=0 9 * * 0
ALERTS_SCHEDULE=*/30 * * * *
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

5. Copia los IDs de las bases de datos desde la URL → `NOTION_BRIEFINGS_DB` y `NOTION_SIGNALS_DB`

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
