# CriptoScope — Guion editorial semanal en X

Guion basado en análisis de métricas reales (semana 16-22 jun 2026).
No modifica ningún archivo de código. Es la hoja de ruta editorial para crecer en X.

---

## La fórmula viral

Los tweets que más impresiones, seguidores y engagement generaron comparten 5 elementos:

```
[emoji urgente] + [cifra exacta] + [ángulo institucional] + [tensión sin resolver] + [imagen]
```

Ejemplo real: 10.582 imp, 635 likes, 101 nuevos seguidores, 199 reposts
> ⚠️ ETFs de Bitcoin pierden $101M en una sesión. RSI en 49,99. Fear & Greed en 22.
> El dinero institucional se está yendo. El mercado espera una señal que aún no llega.

---

## Reglas fijas — se aplican a todos los tweets

- Máx 4-5 tweets por día. Si no hay dato real, no publicar.
- Cada tweet va con imagen. El bot ya genera el chart BTC 4H automático.
- Prohibido empezar con "Hoy", "El mercado" o "BTC ha".
- Prohibido guiones medios o largos (– o —). Sustituir por punto o dos puntos.
- Máx 3 emojis por tweet. Nunca al final de frase.
- Cada tweet termina con pregunta de elección forzada o nivel exacto a vigilar.
- Sin CTAs de Telegram. El contenido es el CTA.

---

## Calendario semanal

### LUNES — máximo alcance (~13.980 imp)

**Tweet 1: Flujo ETF** (publicar en cuanto salgan los datos, aprox 16h hora española)

```
⚠️ ETFs de Bitcoin [acción] $[cifra]M en [sesión].

[Dato que complementa: Fear & Greed, OI, dominancia]. [Qué implicaría si continúa].
Nivel a vigilar: [precio exacto].

[Pregunta corta de elección forzada]
```

Fuente de datos: flujo ETF diario + Fear & Greed del bot + derivados Binance

---

**Tweet 2: Señal técnica del bot** (slot apertura o pulso)

```
🔴/🟢 [Activo] en [precio]. [Lo que dice RSI/estructura]. OI [+/-X%], taker [ratio].

[Lo que significaría si rompe o pierde el nivel]. Stop en [nivel]. Target [nivel].
```

---

### MARTES — buen alcance (~5.866 imp)

**Tweet 1: Ángulo institucional** (Grayscale, Strategy, fundaciones, ETFs)

```
📊 [Entidad] [acción sorprendente]. Desde [fecha/referencia], [dato de magnitud].

[Por qué importa para el precio]. [Tesis contrarian si la hay].
```

**Tweet 2: Narrativa del mercado**

```
[Entidad/persona] no [acción obvia]. [Lo que realmente hace].

[Por qué cambia la lectura del mercado]. [Dato concreto]. [Pregunta].
```

---

### MIÉRCOLES — mantenimiento

**Tweet 1: Derivados / on-chain** (usar slot derivados del bot)

```
⚠️ OI de [activo] [+/-X%] en 20h. Top traders [largo/corto] [ratio]. Taker [ratio].

[Qué dice esa confluencia]. [Si hay divergencia BTC/ETH, mencionarla]. Precio en [nivel].
```

Fuente: `getContextoDerivadosBTC()` — ya disponible en el bot

**Tweet 2: Concepto educativo** (usar "palabra del día" del briefing)

```
Hoy se habla mucho de [concepto]. [Qué es en una frase sin academicismo].

Cuando [condición A], suele significar [implicación A]. Ahora mismo BTC está en escenario [A/B].
```

---

### JUEVES — baja actividad (~279 imp)

Solo publicar si hay macro (CPI, Fed, datos de empleo).

**Tweet 1: Macro con contexto cripto**

```
🔴/🟢 [Dato macro]: [cifra real vs esperada].

La última vez que [dato macro similar], BTC [reacción concreta]. Ahora [diferencia de contexto].
Nivel a vigilar: [precio].
```

Si no hay macro: 1 señal técnica del bot. Nada más.

---

### VIERNES — baja actividad (~404 imp)

Solo publicar si hay algo real que cerrar.

**Tweet 1: Cierre de semana**

```
BTC cierra la semana en [precio] ([+/-X%]). [Lo más importante que pasó].

[Qué queda sin resolver]. [Nivel clave para la semana siguiente].
```

Si el mercado no da nada, no publicar.

---

### SÁBADO — tranquilo

**Tweet 1: Thread histórico / largo plazo**

```
[Activo] lleva [X días] [comportamiento]. Las últimas [N] veces que pasó esto:

1/ [Caso histórico 1 con resultado]
2/ [Caso histórico 2 con resultado]
3/ [Caso histórico 3 con resultado]

Ahora mismo, [diferencia de contexto].
```

1 tweet o thread corto de 3-4 tuits.

---

### DOMINGO — mejor engagement (681 likes, 107 seguidores nuevos)

**Tweet 1: El tweet más trabajado de la semana**

```
🚨 [Hecho institucional impactante]: $[cifra]M [acción].

[Contexto que amplifica: Fear & Greed, OI, smart money]. [Tensión sin resolver: qué señal falta].
```

Tipo: ETF $101M (el que más funcionó). Con imagen obligatoria.

---

**Tweet 2: Resumen narrativo de la semana**

```
La semana que cierra en cripto: [titular en una frase].

[3 cosas que movieron el mercado, en 3 frases cortas]. Lo que viene: [catalizador de la semana siguiente].
```

---

**Tweet 3: Confluencia de derivados** (solo si OI + top L/S + taker están alineados)

```
OI de BTC [+/-X%] en 20h. Top traders [posición]. Taker [ratio: compradores/vendedores agresivos].

Tres señales apuntando en la misma dirección no es casualidad. [Escenario que lo invalidaría].
```

3-4 tweets el domingo. Imagen en los dos primeros.

---

## Fuentes de datos que el bot ya genera

| Dato | De dónde sale |
|------|--------------|
| Precio BTC/ETH + % 24h | `getMarketContext()` |
| Fear & Greed | `getMarketContext()` |
| Flujo ETF (cuando sale) | noticias CoinDesk + alerts |
| OI change 20h | `getBinanceFutures()` |
| Top traders L/S ratio | `getBinanceFutures()` |
| Taker buy/sell ratio | `getBinanceFutures()` |
| Señales técnicas | slots signals.js (7h/11h/15h/19h) |
| Narrativa + noticias | `getNews()` / briefing |
| Concepto del día | campo `palabra_del_dia` del briefing |

---

## Qué NO publicar nunca

- CTAs de Telegram ("síguenos en...", "análisis diario en nuestro canal...")
- Tweets sin dato o evento real detrás
- Tweets sin imagen adjunta
- Predicciones sin estructura técnica que las respalde
- Emojis tribales: 🚀 💎 🙌 WAGMI LFG
- Frases que empiecen con "Hoy", "El mercado", "BTC ha", "Es importante destacar"
- Guiones medios o largos (– o —)

---

*Última actualización: 24 jun 2026 — basado en métricas reales semana 16-22 jun 2026*
