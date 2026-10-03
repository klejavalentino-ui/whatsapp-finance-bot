# 🤖 Personal WhatsApp Expense Tracker (Bot de Finanzas Personales)

Un chatbot personal para WhatsApp ligero, privado y 100% automatizado, diseñado para registrar tus gastos e ingresos diarios mediante lenguaje natural y sincronizarlos en tiempo real en una hoja de cálculo de **Google Sheets**.

Utiliza **Google Gemini (3.8 Flash)** con _Structured Outputs_ para interpretar mensajes cotidianos con precisión quirúrgica, y **@whiskeysockets/baileys** para una conexión directa sin costos de intermediarios (Twilio, Cloud API comercial, etc.).

---

## 📋 Características Principales

- **Conexión Directa y Gratuita:** Usa Baileys (Multi-Device API). Escaneas un código QR una sola vez desde WhatsApp y la sesión queda guardada.
- **Seguridad Estricta (Unipersonal):** Valida el número de teléfono entrante contra una lista blanca (`ALLOWED_PHONE_NUMBER`). Cualquier mensaje de terceros o grupos es ignorado en silencio.
- **Comprensión Inteligente (Gemini Flash):**
  - Entiende frases cotidianas: *"Almuerzo 12.50"*, *"Cobro sueldo 1500"*, *"Uber 800 transporte ayer"*, *"Cena con amigos 45.20"*.
  - Extrae y normaliza: **Tipo** (Gasto/Ingreso), **Monto**, **Categoría** (deducida o explícita), **Concepto** y **Fecha** (resuelve expresiones relativas como *"ayer"*, *"el martes pasado"* o hoy).
  - Incluye fallback con expresiones regulares en caso de pérdida temporal de conectividad con la API de IA.
- **Sincronización con Google Sheets:** Inserta cada movimiento automáticamente usando una cuenta de servicio de Google Cloud (`appendRow` con formato de moneda y fecha).
- **Confirmación Inmediata:** Responde al instante con un resumen ordenado y formateado del registro, o te pide aclaraciones amables si el mensaje es ambiguo o no incluye un monto.
- **Listo para Contenedores:** Incluye `Dockerfile` y `docker-compose.yml` para desplegar en tu PC, servidor casero (Raspberry Pi/miniPC) o VPS.

---

## 🏗️ Estructura del Proyecto

```text
lucid-babbage/
├── credentials/
│   └── service-account.json    # Clave privada de Google Cloud (no se sube a Git)
├── src/
│   ├── config/
│   │   └── env.ts              # Validación y carga tipada de variables de entorno
│   ├── services/
│   │   ├── ai.ts               # Extracción estructurada con Gemini 3.8 Flash + Fallback Regex
│   │   ├── sheets.ts           # Integración con Google Sheets API v4
│   │   └── whatsapp.ts         # Cliente Baileys, render de QR, filtro de remitente y respuestas
│   ├── types/
│   │   └── transaction.ts      # Tipos TypeScript (Transaction, ExtractionResult)
│   └── index.ts                # Punto de entrada y ciclo de vida de la aplicación
├── .env.example                # Plantilla de variables de configuración
├── Dockerfile                  # Construcción multi-stage ligera con Node.js 22 Alpine
├── docker-compose.yml          # Orquestación con persistencia de sesión
├── package.json
└── tsconfig.json
```

---

## 🛠️ Guía Paso a Paso de Configuración

### Paso 1: Configurar Google Sheets y Google Cloud

1. **Crear la Hoja de Cálculo:**
   - Ve a [Google Sheets](https://sheets.new) y crea una nueva hoja (por ejemplo: `Mis Gastos Personales`).
   - Copia el **ID de la hoja** desde la URL en tu navegador:
     ```text
     https://docs.google.com/spreadsheets/d/1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms/edit
                                            ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
                                                      SPREADSHEET_ID
     ```
   - (Opcional) Nombra la primera pestaña como `Movimientos`. Si la hoja está vacía, el bot creará automáticamente los encabezados: `[Fecha, Tipo, Categoría, Descripción, Monto]`.

2. **Crear Service Account en Google Cloud Console:**
   - Ve a [Google Cloud Console](https://console.cloud.google.com/).
   - Crea un nuevo proyecto (o selecciona uno existente).
   - Ve a **APIs y Servicios** > **Biblioteca**.
   - Busca **Google Sheets API** y haz clic en **Habilitar**.
   - Ve a **APIs y Servicios** > **Credenciales**.
   - Haz clic en **Crear credenciales** > **Cuenta de servicio** (Service Account).
   - Asigna un nombre (ej. `bot-finanzas`) y completa el asistente.
   - En la lista de cuentas de servicio, haz clic sobre la cuenta creada, ve a la pestaña **Claves** (Keys).
   - Selecciona **Agregar clave** > **Crear nueva clave** > Selecciona **JSON** y descárgala.
   - Renombra el archivo descargado como `service-account.json` y colócalo en la carpeta `./credentials/service-account.json` del proyecto.
   - **¡MUY IMPORTANTE!** Abre el archivo JSON o copia el campo `client_email` (ej: `bot-finanzas@tu-proyecto.iam.gserviceaccount.com`), vuelve a tu hoja de Google Sheets, pulsa en **Compartir** y dale permisos de **Editor** a ese correo.

---

### Paso 2: Obtener API Key de Gemini

1. Ve a [Google AI Studio](https://aistudio.google.com/).
2. Inicia sesión con tu cuenta de Google y pulsa en **Get API key**.
3. Copia tu clave de API gratuita.

---

### Paso 3: Configurar el archivo `.env`

Copia el archivo `.env.example` como `.env`:

```bash
cp .env.example .env
```

Edita `.env` con tus datos:

```env
# Clave de Gemini
GEMINI_API_KEY=AIzaSyD...tu_clave_aqui
GEMINI_MODEL=gemini-3.8-flash

# Tu número personal (código de país + número, sin signos + ni espacios)
# Ejemplos:
# España: 34612345678
# México: 5215512345678
# Argentina: 5491112345678
# Colombia: 573001234567
ALLOWED_PHONE_NUMBER=34612345678

# ID de Google Sheets y pestaña
SPREADSHEET_ID=1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms
SHEET_NAME=Movimientos

# Ruta de las credenciales
GOOGLE_APPLICATION_CREDENTIALS=./credentials/service-account.json

# Opciones adicionales
WHATSAPP_AUTH_DIR=./auth_session
CURRENCY_SYMBOL=$
```

---

## 🚀 Puesta en Marcha

### Opción A: Ejecución Local con Node.js

1. Instalar dependencias:
   ```bash
   npm install
   ```
2. Iniciar en modo desarrollo (con recarga automática):
   ```bash
   npm run dev
   ```
3. O compilar y ejecutar en producción:
   ```bash
   npm run build
   npm start
   ```

### Opción B: Ejecución con Docker / Docker Compose

Si prefieres aislar el bot en un contenedor o desplegarlo en un VPS Linux:

```bash
# Construir y levantar el contenedor
docker compose up -d

# Ver los logs y escanear el código QR
docker compose logs -f
```

---

## 📱 Vinculación con WhatsApp

1. Al ejecutar el bot por primera vez, verás un **código QR** dibujado en la terminal.
2. Abre WhatsApp en tu teléfono móvil.
3. Ve a **Ajustes / Configuración** > **Dispositivos vinculados** > **Vincular un dispositivo**.
4. Escanea el código QR de la terminal.
5. ¡Listo! La sesión se guardará cifrada en la carpeta `auth_session/`. En futuros reinicios, el bot se conectará automáticamente sin solicitar QR nuevamente.

---

## 💬 Ejemplos de Uso

Envía mensajes desde tu WhatsApp personal:

| Mensaje enviado | Interpretación del Bot | Resultado en Google Sheets |
| :--- | :--- | :--- |
| `Almuerzo 12.50` | Gasto de $12.50 en categoría Comida | `[2026-10-02, Gasto, Comida, Almuerzo, 12.5]` |
| `Cobro sueldo 1500` | Ingreso de $1500 en categoría Sueldo | `[2026-10-02, Ingreso, Sueldo, Cobro de sueldo, 1500]` |
| `Uber 800 transporte ayer` | Gasto de $800 en categoría Transporte con fecha de ayer | `[2026-10-01, Gasto, Transporte, Uber, 800]` |
| `Farmacia 32 medicamentos` | Gasto de $32 en categoría Salud | `[2026-10-02, Gasto, Salud, Medicamentos, 32]` |

### Respuestas del Bot

- **Confirmación exitosa:**
  ```text
  ✅ Registrado con éxito:
  • Tipo: Gasto
  • Monto: $12.50
  • Categoría: Comida
  • Concepto: Almuerzo
  • Fecha: 2026-10-02
  ```

- **Si falta información:**
  ```text
  ⚠️ No pude interpretar la transacción.

  Por favor asegúrate de incluir el concepto y el monto.
  Ejemplos:
  • Almuerzo 12.50
  • Cobro sueldo 1500
  • Uber 800 transporte ayer
  ```

---

## ☁️ Despliegue en Render

El bot incluye compatibilidad nativa con **Render** como Web Service:
1. Sube este repositorio a tu cuenta de **GitHub**.
2. Entra en [Render Dashboard](https://dashboard.render.com/) > **New +** > **Blueprint**.
3. Selecciona tu repositorio de GitHub (Render detectará automáticamente el archivo `render.yaml`).
4. Configura las variables de entorno en el panel de Render:
   - `GEMINI_API_KEY`: Tu clave de Google AI Studio.
   - `ALLOWED_PHONE_NUMBER`: Tu número de teléfono con código de país (ej. `34642448328`).
   - `SPREADSHEET_ID`: El ID de tu hoja de Google Sheets.
   - `GOOGLE_SERVICE_ACCOUNT_JSON`: Pega el contenido JSON completo de tu `service-account.json` en una sola línea.
5. Haz clic en **Apply / Deploy**.
6. En cuanto el servicio inicie, entra en tu URL pública generada por Render añadiendo `/qr` (ej: `https://tu-bot.onrender.com/qr`) para escanear el código QR directamente desde el navegador.

---

## 🔒 Mecanismo de Seguridad y Privacidad

- **Filtro estricto de remitente:** El bot comprueba cada mensaje entrante contra `ALLOWED_PHONE_NUMBER` y tu identificador personal `LID`. Si cualquier persona ajena escribe al número, el mensaje se descarta antes de llegar a la IA o a Google Sheets.
- **Grupos desactivados:** Por diseño, el bot descarta mensajes provenientes de grupos de WhatsApp (`@g.us`).
- **Autonomía:** Tus datos van directamente de tu WhatsApp a Google Gemini y a tu Google Drive personal sin intermediarios.
