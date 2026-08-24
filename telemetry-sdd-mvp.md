# Software Design Document: Wardx SDK MVP

**Product:** Wardx  
**Status:** Draft v0.1  
**Scope inicial:** Node.js SDK + Node.js ingest server + stress harness  
**Objetivo posterior:** portar el mismo protocolo y semántica a C#, Unity, Web, Swift y Kotlin.

---

## 1. Objetivo

Construir **Wardx**, un SDK liviano de telemetría que combine:

- logs estructurados;
- eventos de producto;
- métricas agregables como counters, gauges e histogramas;
- timers;
- Remote Config;
- experimentación A/B determinista sobre variables remotas.

El SDK debe priorizar el rendimiento de la aplicación instrumentada. Una llamada de medición nunca debe hacer I/O de red, esperar una Promise, comprimir datos ni bloquear esperando al servidor.

El sistema se considera **best effort**: perder una pequeña cantidad de telemetría por una falla de red es aceptable. La aplicación observada siempre tiene prioridad sobre la telemetría.

---

## 2. Principios de diseño

1. **Hot path mínimo.** Medir debe equivaler a modificar memoria local.
2. **Sin dependencia de conexión persistente.** No usar WebSocket en el MVP.
3. **HTTP estándar.** El protocolo debe ser trivial de implementar en otras plataformas.
4. **Procesamiento en el borde.** El cliente agrega y consolida antes de transmitir.
5. **Batching.** Muchos eventos locales producen pocos requests.
6. **Backpressure por descarte.** Si el SDK no puede seguir el ritmo, descarta telemetría en lugar de afectar la aplicación.
7. **Configuración local-first.** Remote Config se consulta siempre desde memoria local.
8. **Experimentos locales.** La asignación A/B ocurre localmente y de forma determinista.
9. **Protocolo versionado.** Los SDK futuros deben poder interoperar con el mismo servidor.
10. **Sin código remoto.** Remote Config transmite datos, nunca funciones ni código ejecutable.

---

## 3. Arquitectura general

```text
Application
    |
    v
Wardx SDK
    |
    +-- Metrics Aggregator
    |      +-- Counter
    |      +-- Gauge
    |      +-- Histogram
    |      +-- Timer
    |
    +-- Event Buffer
    |
    +-- Log Buffer
    |
    +-- Remote Config Snapshot
    |
    +-- Experiment Resolver
    |
    v
Frame Builder
    |
    v
Serializer / Compressor
    |
    v
HTTP Sync Transport
    |
    v
Node Ingest Server
    |
    +-- Frame ingestion
    +-- Server aggregation
    +-- Remote Config
    +-- Experiment definitions
    +-- Development sinks
```

---

## 4. Conexión cliente-servidor

### 4.1 Decisión

El MVP utilizará **HTTP/HTTPS request-response**.

No se utilizarán:

- WebSockets;
- Socket.IO;
- MQTT;
- conexiones persistentes administradas por el SDK;
- protocolos binarios propios.

La unidad de comunicación será un `sync` periódico.

```http
POST /v1/sync
Content-Type: application/json
Content-Encoding: gzip
X-Wardx-Key: project_key
```

Un mismo request sirve para:

1. enviar uno o más frames de telemetría;
2. informar qué versión de Remote Config posee el cliente;
3. recibir Remote Config nuevo si existe.

Esto evita crear un canal adicional para configuración.

### 4.2 Best-effort delivery

En el MVP, los frames son **at-most-once** por defecto.

Si un envío falla:

- el SDK incrementa una métrica interna;
- descarta el batch enviado;
- continúa funcionando;
- intenta nuevamente en el siguiente intervalo con datos nuevos.

No habrá cola persistente en disco en la primera versión.

Esta decisión elimina:

- duplicación por retries ambiguos;
- almacenamiento local;
- recuperación de sesiones;
- lógica de acknowledgements compleja.

Más adelante se podrá agregar un modo `reliable` opcional.

### 4.3 Intervalos iniciales

Valores sugeridos:

```json
{
  "aggregateIntervalMs": 1000,
  "syncIntervalMs": 15000,
  "maxBufferedEvents": 5000,
  "maxBufferedLogs": 2000,
  "maxFrameBytes": 524288
}
```

Estos valores podrán ser modificados posteriormente mediante Remote Config interno del SDK.

### 4.4 Jitter

Para evitar que miles de clientes sincronicen exactamente al mismo tiempo:

```text
actualInterval = syncInterval * random(0.85, 1.15)
```

El jitter se calcula nuevamente para cada ciclo.

---

## 5. Protocolo Sync v1

### 5.1 Request

```json
{
  "protocol": 1,
  "project": "my-game",
  "sdk": {
    "name": "wardx-node",
    "version": "0.1.0"
  },
  "client": {
    "instanceId": "01J...",
    "sessionId": "01J...",
    "appVersion": "2.4.1",
    "environment": "production",
    "platform": "node"
  },
  "configVersion": 12,
  "frames": [
    {
      "seq": 42,
      "from": 1787221120000,
      "to": 1787221135000,
      "metrics": {},
      "events": [],
      "logs": []
    }
  ]
}
```

### 5.2 Response

Si no cambió la configuración:

```json
{
  "ok": true,
  "serverTime": 1787221135102,
  "configVersion": 12
}
```

Si cambió:

```json
{
  "ok": true,
  "serverTime": 1787221135102,
  "configVersion": 13,
  "config": {
    "values": {},
    "experiments": []
  }
}
```

### 5.3 Bootstrap

Al iniciar, el SDK puede realizar inmediatamente un `/v1/sync` con `frames: []` para obtener configuración sin esperar al primer flush.

Si falla, la aplicación continúa con valores locales por defecto.

---

## 6. API pública del SDK Node.js

### 6.1 Inicialización

```js
import { createWardx } from 'wardx';

const wardx = createWardx({
  endpoint: 'https://ingest.wardx.dev',
  projectKey: 'dev_project_key',
  project: 'demo',
  role: 'game-server',
  appVersion: '2.4.1',
  environment: 'production',
  privacySalt: 'demo-subject-hash-v1'
});
```

La creación del objeto no debe requerir conectividad.

### 6.2 Logs

```js
wardx.log.info('match_started', {
  mode: 'ranked',
  players: 4
});

wardx.log.error('payment_failed', {
  provider: 'stripe',
  code: 'timeout'
});
```

Los niveles iniciales serán:

```text
debug
info
warn
error
```

### 6.3 Events

```js
wardx.event('match.started', {
  mode: 'ranked',
  country: 'AR'
});
```

Los eventos permanecen individualizados salvo que explícitamente se utilice una métrica agregable.

### 6.4 Counters

```js
wardx.counter('match.completed').inc();
wardx.counter('coins.spent').add(50);
```

Con dimensiones:

```js
wardx.counter('match.completed', {
  mode: 'ranked',
  platform: 'android'
}).inc();
```

### 6.5 Gauges

```js
wardx.gauge('players.online').set(12492);
```

### 6.6 Histograms

```js
wardx.histogram('request.duration', {
  buckets: [10, 25, 50, 100, 250, 500, 1000]
}).observe(42);
```

### 6.7 Timer

```js
const end = wardx.timer('matchmaking.duration');

// work

end({ result: 'success' });
```

El timer alimenta internamente un histograma.

### 6.8 Flush y shutdown

```js
await wardx.flush();
await wardx.shutdown();
```

Estas son las únicas operaciones públicas que pueden esperar I/O.

---

## 7. Hot path

La instrumentación debe evitar en la medida de lo posible:

- `JSON.stringify()`;
- gzip;
- acceso a filesystem;
- HTTP;
- creación de Promises;
- validación compleja;
- lectura de variables de entorno;
- cálculo de configuración remota;
- timestamps de alta precisión innecesarios.

Ejemplo conceptual de un counter:

```js
counter.value += 1;
```

Para logs y eventos se insertará una representación compacta en un buffer en memoria.

### 7.1 Double buffering

Durante el flush se intercambiarán referencias:

```text
activeBuffer -> sealedBuffer
new empty buffer -> activeBuffer
```

La aplicación vuelve inmediatamente a escribir sobre el nuevo buffer.

El `sealedBuffer` se procesa fuera de las llamadas de instrumentación.

### 7.2 Worker thread

El MVP comenzará sin `worker_threads` para mantener la arquitectura pequeña.

Serialización y compresión ocurrirán fuera del hot path. Los stress tests medirán event-loop lag durante los flushes.

Si los objetivos de latencia no se cumplen, el primer cambio arquitectónico será mover:

- serialización;
- compresión;
- transporte;

a un worker dedicado.

La API pública no cambiará.

---

## 8. Agregación de métricas

### 8.1 Counter

```text
requests = requests + n
```

El frame transmite solamente el valor acumulado durante la ventana.

### 8.2 Gauge

El frame transmite:

```json
{
  "value": 123,
  "timestamp": 1787221134000
}
```

### 8.3 Histogram

Internamente:

```text
count
sum
min
max
bucket counts
```

Ejemplo:

```json
{
  "count": 182934,
  "sum": 7829124,
  "min": 3,
  "max": 1820,
  "buckets": [
    [10, 12892],
    [25, 48192],
    [50, 92331],
    [100, 23192],
    [250, 5021]
  ]
}
```

No se transmiten observaciones individuales.

---

## 9. Cardinalidad

Las dimensiones son útiles, pero representan uno de los principales riesgos del sistema.

Correcto:

```js
{
  country: 'AR',
  platform: 'android',
  mode: 'ranked'
}
```

Incorrecto como dimensión:

```js
{
  userId: '183718237123'
}
```

El SDK tendrá:

```text
maxSeriesPerMetric
maxDimensionKeys
maxDimensionValueLength
```

Valores iniciales sugeridos:

```json
{
  "maxSeriesPerMetric": 1000,
  "maxDimensionKeys": 8,
  "maxDimensionValueLength": 64
}
```

Al superar el límite:

- se rechaza la nueva serie;
- no se bloquea la aplicación;
- se incrementa `wardx.internal.cardinality_dropped`.

---

## 10. Backpressure

La prioridad siempre es proteger a la aplicación.

Si los buffers alcanzan su límite:

```text
application
    |
    v
wardx buffer full
    |
    +--> drop telemetry
    |
    +--> increment internal dropped counter
```

Nunca se esperará a que haya espacio disponible.

Prioridad sugerida de descarte:

1. `debug` logs;
2. `info` logs;
3. eventos de baja prioridad;
4. `warn` logs;
5. `error` logs.

Counters, gauges e histogramas agregados no utilizan una entrada por medición y, por lo tanto, deben sobrevivir mejor a presión de memoria.

---

## 11. Remote Config

### 11.1 Modelo

El servidor mantiene un snapshot versionado:

```json
{
  "version": 13,
  "values": {
    "matchmaking.timeoutMs": 5000,
    "chat.enabled": true,
    "rewards.multiplier": 1.2,
    "ai.temperature": 0.7
  }
}
```

El cliente mantiene el último snapshot válido completamente en memoria.

### 11.2 API

```js
const timeout = wardx.config.get(
  'matchmaking.timeoutMs',
  3000
);
```

La lectura es completamente síncrona y local.

Si no existe la variable:

```text
return fallback
```

Si el servidor deja de responder:

```text
keep last known config
```

Si nunca se obtuvo configuración:

```text
use application fallback
```

### 11.3 Tipos permitidos

Remote Config v1 soportará solamente valores JSON:

```text
boolean
number
string
null
array
object
```

No se permitirá código remoto ni expresiones ejecutables.

---

## 12. Experimentos A/B

### 12.1 Idea central

Los experimentos serán una capa sobre Remote Config.

La aplicación continúa solicitando variables. No necesita implementar un segundo sistema de flags.

Ejemplo normal:

```js
const delay = wardx.config.get('message.delayMs', 1000);
```

Ejemplo sujeto a experimento:

```js
const delay = wardx.config.get('message.delayMs', 1000, {
  subjectId: user.id
});
```

Si `message.delayMs` participa en un experimento activo, el SDK selecciona localmente la variante para ese sujeto.

### 12.2 Definición remota

```json
{
  "id": "message-delay-v1",
  "enabled": true,
  "allocation": 1,
  "salt": "3ad8f9",
  "primaryMetric": "message.sent",
  "variants": [
    {
      "key": "control",
      "weight": 50,
      "values": {
        "message.delayMs": 1000
      }
    },
    {
      "key": "fast",
      "weight": 50,
      "values": {
        "message.delayMs": 400
      }
    }
  ]
}
```

También pueden existir más de dos variantes.

### 12.3 Asignación determinista

La variante se calcula mediante:

```text
hash(experimentId + ':' + subjectId + ':' + salt)
```

Para garantizar resultados idénticos entre lenguajes se utilizará:

```text
FNV-1a 32-bit sobre bytes UTF-8
```

Resultado:

```text
0 .. 2^32-1
```

Normalización:

```text
bucket = hash / 2^32
```

Luego se selecciona la variante según los pesos acumulados.

Propiedades:

- mismo sujeto + mismo experimento + mismo salt = misma variante;
- no requiere consultar al servidor durante la decisión;
- funciona igual en Node, C#, browser, Swift y Kotlin;
- cambiar el `salt` permite redistribuir la población deliberadamente.

### 12.4 Allocation

`allocation` controla qué proporción total participa.

```json
{
  "allocation": 0.2
}
```

significa que solamente 20% de la población entra al experimento.

El resto recibe el valor normal de Remote Config o el fallback de la aplicación.

### 12.5 Exposure

Un usuario cuenta como expuesto solamente cuando el código realmente lee una variable experimental.

La primera lectura genera internamente:

```text
experiment.exposure
```

con:

```json
{
  "experiment": "message-delay-v1",
  "variant": "fast",
  "subject": "hashed-subject-id"
}
```

La misma exposición no debe emitirse repetidamente dentro de la misma sesión.

### 12.6 Goal

La aplicación puede registrar una métrica objetivo:

```js
wardx.experiment.goal('message.sent', {
  subjectId: user.id
});
```

O un valor cuantitativo:

```js
wardx.experiment.goal('session.duration', {
  subjectId: user.id,
  value: 842
});
```

El SDK adjunta automáticamente los experimentos relevantes conocidos para ese sujeto durante la sesión cuando sea posible.

### 12.7 Privacidad del subjectId

El `subjectId` sin procesar no debe transmitirse por defecto.

El SDK transmitirá un hash estable por proyecto:

```text
subjectHash = hash(projectSalt + ':' + subjectId)
```

El objetivo no es criptografía fuerte, sino evitar almacenar accidentalmente identificadores directos en la telemetría básica.

Para instalaciones con requisitos de privacidad superiores podrá reemplazarse por HMAC en una versión posterior.

---

## 13. Relación entre Remote Config y experimentos

Orden de resolución:

```text
config.get(key, fallback, context)
        |
        v
Does remote value exist?
        |
        +-- no --> fallback
        |
        v
Is key part of active experiment?
        |
        +-- no --> remote value
        |
        v
Is subjectId available?
        |
        +-- no --> remote value
        |
        v
Is subject allocated?
        |
        +-- no --> remote value
        |
        v
Resolve deterministic variant
        |
        v
Return variant value
        |
        v
Record exposure asynchronously
```

Esto mantiene una única interfaz mental para la aplicación.

---

## 14. Formato interno de Frame

Ejemplo conceptual:

```json
{
  "seq": 42,
  "from": 1787221120000,
  "to": 1787221135000,
  "metrics": {
    "counters": [
      ["match.completed", {"mode":"ranked"}, 18392]
    ],
    "gauges": [
      ["players.online", null, 12921]
    ],
    "histograms": []
  },
  "events": [
    [1787221124812, "purchase", {"product":"premium"}]
  ],
  "logs": [
    [1787221125823, "error", "payment_failed", {"code":"timeout"}]
  ]
}
```

El formato usa arrays en las colecciones de alto volumen para reducir repetición de claves.

En desarrollo se mantendrá JSON legible.

---

## 15. Compresión

### MVP

```text
JSON
+
gzip
```

Razones:

- soporte universal;
- fácil inspección;
- implementación trivial en Node;
- soporte simple en C#, browser, mobile y servidores HTTP;
- permite comparar tamaño real antes de introducir un protocolo binario.

La mayor reducción debe provenir primero de la **agregación semántica** y no del algoritmo de compresión.

### Futuro

Sólo si las mediciones lo justifican:

```text
MessagePack / CBOR
+
zstd
```

El protocolo incluirá versión y encoding para permitir la evolución.

---

## 16. Node.js client architecture

Estructura sugerida:

```text
packages/
  core/                 # @wardx/core
    src/
      metrics/
        Counter.js
        Gauge.js
        Histogram.js
        Timer.js
      buffers/
        EventBuffer.js
        LogBuffer.js
      config/
        ConfigStore.js
        ExperimentResolver.js
        hash.js
      frame/
        FrameBuilder.js
      WardxCore.js

  node/                 # published as `wardx`
    src/
      WardxNode.js
      transport/
        HttpTransport.js
      compression/
        gzip.js
      runtime/
        processMetrics.js

  server/               # @wardx/server
    src/
      server.js
      ingest/
        syncHandler.js
      config/
        ConfigRepository.js
      aggregation/
        FrameAggregator.js
      control/
        ControlService.js
      mcp/
        tools.js
        stdio.js
      sinks/
        NullSink.js
        MemorySink.js
        NdjsonSink.js

  stress/               # @wardx/stress
    src/
      client-benchmark.js
      fleet-simulator.js
      server-benchmark.js
```

Se utilizarán ES Modules.

---

## 17. Node.js server

### 17.1 Responsabilidad del endpoint

`POST /v1/sync` debe hacer solamente:

```text
receive
    |
    v
authenticate project key
    |
    v
decompress if necessary
    |
    v
parse protocol envelope
    |
    v
basic validation
    |
    v
hand frames to ingest pipeline
    |
    v
compare config version
    |
    v
respond
```

No debe realizar análisis estadístico pesado dentro del request.

### 17.2 Implementación inicial

Para el MVP se utilizarán primitivas nativas de Node.js:

```text
node:http
node:zlib
```

Esto permite medir el costo real del protocolo sin introducir un framework como variable adicional.

### 17.3 Sinks

Se implementarán tres sinks:

#### NullSink

Descarta todo luego de validarlo.

Uso:

```text
máximo throughput del servidor
```

#### MemorySink

Mantiene agregados básicos en memoria.

Uso:

```text
pruebas funcionales
```

#### NdjsonSink

Escribe frames como NDJSON para inspección y debugging.

Uso:

```text
desarrollo local
```

No se utilizará NDJSON como benchmark principal porque el filesystem distorsionaría la medición del ingest server.

---

## 18. Server aggregation

Los frames ya llegan preagregados.

El servidor debe poder consolidar ventanas:

```text
15 sec client frames
       |
       v
1 minute
       |
       v
5 minutes
       |
       v
1 hour
```

Para el MVP solamente se implementará agregación de 1 minuto en memoria para validar el modelo.

Persistencia definitiva queda fuera de alcance.

---

## 19. Métricas internas del SDK

El sistema debe observarse a sí mismo.

Como mínimo:

```text
wardx.internal.events_buffered
wardx.internal.logs_buffered
wardx.internal.events_dropped
wardx.internal.logs_dropped
wardx.internal.cardinality_dropped
wardx.internal.frames_sent
wardx.internal.frames_failed
wardx.internal.bytes_uncompressed
wardx.internal.bytes_compressed
wardx.internal.last_sync_ms
wardx.internal.config_version
```

Estas métricas se incorporan al siguiente frame sin generar recursividad.

---

## 20. Stress test plan

El MVP no se considera terminado hasta ejecutar stress tests reproducibles.

### 20.1 Test A: Counter hot path

```js
for (let i = 0; i < 10_000_000; i++) {
  counter.inc();
}
```

Medir:

- operaciones por segundo;
- nanosegundos/microsegundos por llamada;
- memoria;
- garbage collection;
- event-loop delay.

### 20.2 Test B: Mixed instrumentation

Carga sintética:

```text
70% counter.inc()
15% histogram.observe()
10% event()
5% log.info()
```

Escenarios:

```text
10k ops/s
50k ops/s
100k ops/s
250k ops/s
```

Duración mínima por escenario:

```text
5 minutes
```

### 20.3 Test C: Flush spike

Crear un frame cerca del máximo permitido y medir:

- tiempo de snapshot;
- `JSON.stringify()`;
- gzip;
- event-loop delay durante flush;
- memoria temporal adicional.

Este test decide si el MVP necesita worker thread.

### 20.4 Test D: Server raw ingest

Usar `NullSink`.

Escenarios objetivo:

```text
1,000 sync/s
2,500 sync/s
5,000 sync/s
10,000 sync/s
```

Medir:

- requests/s;
- p50 latency;
- p95 latency;
- p99 latency;
- CPU;
- RSS memory;
- event-loop delay;
- error rate.

### 20.5 Test E: Fleet simulator

Crear procesos que simulen clientes reales:

```text
10,000 clients / 15 sec = ~667 sync/s average
50,000 clients / 15 sec = ~3,333 sync/s average
100,000 clients / 15 sec = ~6,667 sync/s average
```

Todos deben utilizar jitter para reproducir un despliegue real.

### 20.6 Test F: Remote Config storm

Cambiar `configVersion` mientras hay tráfico alto y verificar que:

- todos los responses puedan devolver el nuevo snapshot;
- el servidor no tenga que recalcular configuración por cliente;
- el snapshot se serialice una sola vez por versión cuando sea posible;
- la actualización no produzca una degradación fuerte del ingest.

### 20.7 Test G: Experiment consistency

Generar un millón de `subjectId` y verificar:

- distribución de variantes;
- estabilidad de asignación;
- igualdad entre implementaciones independientes del hash;
- respeto de `allocation`;
- respeto de pesos.

Cuando exista el SDK C#, este test será parte del contrato cross-platform.

---

## 21. Objetivos de rendimiento iniciales

Los siguientes valores funcionan como gates de ingeniería, no como promesas públicas.

### Client

```text
counter.inc() p99                  < 2 us
histogram.observe() p99            < 5 us
event() p99                        < 10 us
log.info() p99                     < 10 us
network calls from hot path        0
filesystem calls from hot path     0
Promise creation required          0
```

### Runtime

Con una carga mixta de `100k wardx ops/s`:

```text
additional event-loop p99 delay    < 5 ms
unbounded memory growth            0
```

### Server

Con `NullSink` y payloads representativos:

```text
5,000 sync/s sustained
HTTP error rate < 0.1%
p99 latency < 100 ms
unbounded memory growth = 0
```

Los números se ajustarán luego de obtener la primera línea base real.

---

## 22. Remote Config performance

El servidor no debe construir el JSON de configuración para cada request.

Por cada versión se mantiene:

```text
config object
serialized JSON
optional gzipped representation
```

El request únicamente compara:

```text
client.configVersion === server.configVersion
```

Si son iguales, no envía el snapshot.

Esto hace que Remote Config tenga un costo marginal muy bajo incluso con muchos clientes.

---

## 23. Seguridad mínima

### Producción

Usar HTTPS.

### Wardx key

```http
X-Wardx-Key: ...
```

La key identifica el proyecto y permite limitar ingest.

En browser/mobile esta key debe considerarse **pública al cliente** y no puede proteger operaciones administrativas sensibles.

### Administración

La modificación de Remote Config, experimentos y versiones ocurre por MCP en el mismo proceso que el ingest. No forma parte del SDK público ni de HTTP.

### Remote Config

Nunca almacenar secretos en Remote Config porque los valores terminan en aplicaciones cliente.

---

## 24. Fuera de alcance del MVP

No implementar todavía:

- dashboard web;
- base de datos productiva;
- WebSockets;
- streaming continuo;
- OpenTelemetry completo;
- distributed tracing;
- spans arbitrarios;
- colas persistentes del cliente;
- retries confiables;
- exactly-once delivery;
- machine learning;
- análisis automático de experimentos;
- segmentación avanzada;
- targeting geográfico;
- administración visual de Remote Config (el control plane es MCP);
- SDK C#;
- SDK browser;
- SDK Unity.

El objetivo es validar primero el núcleo y el protocolo.

---

## 25. MVP repository

```text
wardx/
  package.json
  packages/
    core/          # @wardx/core
    node/          # wardx
    server/        # @wardx/server
    stress/        # @wardx/stress
  examples/
    basic-node/
  config/
    development.json
  docs/
    PROTOCOL.md
    STRESS.md
```

Workspace npm:

```json
{
  "type": "module",
  "workspaces": [
    "packages/*",
    "examples/*"
  ]
}
```

---

## 26. Orden de implementación

### Phase 1: Core metrics

Implementar:

```text
Counter
Gauge
Histogram
Timer
EventBuffer
LogBuffer
```

Crear inmediatamente los microbenchmarks.

### Phase 2: Frame

Implementar:

```text
snapshot
buffer swap
frame builder
JSON serialization
gzip
```

### Phase 3: Sync protocol

Implementar:

```text
Node HTTP client
POST /v1/sync
Node ingest server
NullSink
MemorySink
```

### Phase 4: Remote Config

Implementar:

```text
configVersion
ConfigStore
bootstrap sync
config.get()
server ConfigRepository
```

### Phase 5: Experiments

Implementar:

```text
FNV-1a cross-platform specification
allocation
weighted variants
config overrides
exposure tracking
goal tracking
```

### Phase 6: Stress harness

Implementar y ejecutar:

```text
hot-path benchmark
mixed workload
flush benchmark
server benchmark
fleet simulator
config storm
experiment consistency
```

### Phase 7: Decision gate

Con datos reales decidir:

```text
worker thread needed?
15 sec sync correct?
JSON + gzip sufficient?
frame limit correct?
server process clustering needed?
```

No optimizar estos puntos antes de medirlos.

---

## 27. Contrato para futuros SDK

Todo SDK futuro debe implementar exactamente estas capacidades mínimas:

```text
log
event
counter
gauge
histogram
timer
config.get
experiment.goal
flush
shutdown
```

Y respetar exactamente:

```text
Sync Protocol v1
Frame semantics
FNV-1a UTF-8 bucketing
variant weighting
allocation semantics
Remote Config versioning
```

La implementación interna puede variar según la plataforma.

Ejemplos:

```text
Node.js       event loop + buffers
Browser       Web Worker + IndexedDB later
C# / Unity    background worker + concurrent structures
Swift         background queue
Kotlin        coroutine/worker
```

El protocolo es el producto estable; cada SDK es un adaptador a su plataforma.

---

## 28. Criterio de éxito del MVP

El MVP queda validado cuando se demuestra que:

1. una aplicación Node puede generar telemetría a alta frecuencia sin I/O en las llamadas de medición;
2. el cliente consolida miles de mediciones en frames pequeños;
3. el servidor recibe miles de syncs por segundo de forma sostenida;
4. una caída del servidor no degrada la aplicación cliente;
5. Remote Config se actualiza mediante el mismo canal HTTP;
6. `config.get()` nunca depende de la red;
7. los experimentos asignan variantes localmente y de forma estable;
8. exposiciones y objetivos llegan al pipeline de telemetría normal;
9. la arquitectura puede portarse a otro lenguaje implementando el mismo protocolo.

---

## 29. Decisión arquitectónica principal

La pieza central del sistema no es el log, la métrica ni el request HTTP.

Es el **Wardx Frame**: una ventana compacta de comportamiento local que el cliente ya procesó antes de enviarla.

Wardx mide en memoria, agrega en el cliente y sincroniza frames.

Remote Config utiliza el viaje de retorno del mismo protocolo, y los experimentos son una regla de resolución local sobre esas variables.

```text
Application behavior
        |
        v
Local measurement
        |
        v
Client aggregation
        |
        v
Wardx Frame
        |
        v
HTTP /v1/sync
        |
        +------> Server ingest
        |
        <------ Remote Config snapshot
        |
        v
Local config + experiment resolver
```

Este diseño mantiene el servidor simple, reduce tráfico, desacopla la aplicación de la disponibilidad del backend y deja un contrato pequeño para implementar SDKs en múltiples plataformas.
