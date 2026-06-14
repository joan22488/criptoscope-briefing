# ☕ CriptoScope Briefing Matinal

Sistema automático que cada mañana:
1. **Recopila** noticias cripto/macro + precios BTC/ETH + funding + open interest (CoinDesk Data API)
2. **Relaciona** todo con Claude y genera el paquete del día en voz CriptoScope
3. **Publica** el briefing en Telegram y **guarda** el guion de vídeo + thread listos para usar

```
CoinDesk API ──→ Claude API ──→ Telegram (briefing + pregunta del día)
                          └───→ output/AAAA-MM-DD/ (guion-video.md, thread.md)
```

---

## 1. Requisitos

- **Node.js 18 o superior** (comprueba con `node -v`)
- Tres claves (las pones en el archivo `.env`):

### 🔑 Claude API
1. Entra en https://console.anthropic.com
2. Settings → API Keys → Create Key
3. Copia la clave (empieza por `sk-ant-`)

### 🔑 CoinDesk Data API
1. Entra en https://developers.coindesk.com
2. Crea cuenta gratuita → genera API Key
3. El plan gratuito da de sobra para 1 ejecución diaria

### 🔑 Telegram Bot
1. En Telegram, habla con **@BotFather** → `/newbot` → ponle nombre
2. Copia el **token** que te da
3. Añade el bot como **administrador** de tu canal de CriptoScope
4. Para sacar el **chat_id** del canal: reenvía un mensaje del canal a **@userinfobot**, o publica algo en el canal y visita `https://api.telegram.org/bot<TU_TOKEN>/getUpdates` (el id de canales empieza por `-100`)

---

## 2. Instalación (Windows)

```powershell
# 1. Entra en la carpeta del proyecto
cd D:\JOAN\criptoscope-briefing

# 2. Instala dependencias
npm install

# 3. Crea tu archivo de configuración
copy .env.example .env

# 4. Abre .env con el bloc de notas y rellena tus 3 claves
notepad .env
```

---

## 3. Probar antes de automatizar

**Paso 1 — Probar Telegram** (lo más rápido de verificar):
```powershell
npm run test-telegram
```
Debe llegar un mensaje a tu canal. Si falla, el problema está en el token o el chat_id.

**Paso 2 — Ejecutar un briefing completo ahora mismo:**
```powershell
npm run once
```
Esto hace el ciclo entero: datos → Claude → Telegram → archivos en `output/`.
Revisa el briefing en Telegram y los archivos `guion-video.md` y `thread.md` en `output/AAAA-MM-DD/`.

---

## 4. Automatizar cada mañana

### Opción A — Dejar el proceso corriendo
```powershell
npm start
```
Queda esperando y publica cada día a las 7:00 (configurable en `.env` → `CRON_SCHEDULE`).
Sirve si tienes el PC siempre encendido. Para que sobreviva a reinicios, usa `pm2`:
```powershell
npm install -g pm2
pm2 start src/index.js --name criptoscope-briefing
pm2 save
```

### Opción B — Programador de tareas de Windows (recomendado si apagas el PC)
1. Abre **Programador de tareas** → Crear tarea básica
2. Desencadenador: Diariamente a las 7:00
3. Acción: Iniciar un programa
   - Programa: `node`
   - Argumentos: `src/run-once.js`
   - Iniciar en: `D:\JOAN\criptoscope-briefing`

Así no necesitas proceso permanente: Windows lo lanza, se ejecuta y se cierra.

---

## 5. Afinar la voz y el formato

Todo el tono y la estructura viven en **`src/prompts.js`**:
- `VOZ_CRIPTOSCOPE` → el carácter de la marca (el precio manda, anti-humo...)
- `INSTRUCCIONES_BRIEFING` → estructura del briefing, del guion y del thread

Edita, ejecuta `npm run once`, y compara. Itera hasta que suene 100% a ti.

## 6. Configuración rápida (.env)

| Variable | Qué hace |
|---|---|
| `CRON_SCHEDULE` | Hora de publicación (`0 7 * * *` = 7:00 diario) |
| `MAIN_INSTRUMENT` | Perpetuo a vigilar (por defecto ETH-USDT) |
| `FUTURES_MARKET` | Exchange de derivados (por defecto binance) |
| `CLAUDE_MODEL` | Modelo de Claude (sonnet = buen coste para uso diario) |

---

## 7. Solución de problemas

| Síntoma | Causa probable |
|---|---|
| `Telegram error: chat not found` | El bot no es admin del canal, o chat_id mal (recuerda el `-100`) |
| `CoinDesk → HTTP 401` | API key incorrecta o sin activar |
| `HTTP 404` en funding/OI | El nombre del instrumento no existe en ese exchange: comprueba el formato exacto en https://developers.coindesk.com (el código sigue funcionando sin ese dato) |
| Claude devuelve texto sin JSON | Se guarda igualmente como briefing crudo; revisa `output/` |
| No publica a la hora | Comprueba `TIMEZONE=Europe/Madrid` y que el proceso/tarea está activo |

## 8. Próximas fases (hoja de ruta)

- **Fase 2:** detector de narrativas (comparar briefings de días anteriores)
- **Fase 3:** modo "desmiente" (detectar el claim viral dudoso del día)
- **Fase 4:** dato on-chain del día + imagen para stories (reutilizando el Briefing Studio)
