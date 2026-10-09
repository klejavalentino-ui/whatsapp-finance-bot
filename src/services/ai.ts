import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config/env.js';
import { CurrencyType, ExtractionResult, Transaction, TransactionType } from '../types/transaction.js';

let genAIClient: GoogleGenAI | null = null;

function getClient(): GoogleGenAI | null {
  if (!config.geminiApiKey) {
    return null;
  }
  if (!genAIClient) {
    genAIClient = new GoogleGenAI({ apiKey: config.geminiApiKey });
  }
  return genAIClient;
}

/**
 * Obtiene la fecha actual en formato YYYY-MM-DD y el nombre del día para referencia temporal del LLM.
 */
function getCurrentDateContext(): { isoDate: string; fullContext: string } {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const isoDate = `${year}-${month}-${day}`;

  const daysOfWeek = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const dayName = daysOfWeek[now.getDay()];

  return {
    isoDate,
    fullContext: `Hoy es ${dayName}, ${isoDate} (Zona local).`,
  };
}

/**
 * Extrae la transacción utilizando Gemini Flash con Structured Outputs (JSON Schema).
 */
export async function parseTransactionWithGemini(userText: string): Promise<ExtractionResult> {
  const client = getClient();
  const { isoDate, fullContext } = getCurrentDateContext();

  // Si no hay API key configurada, usamos el parser de contingencia por Regex
  if (!client) {
    console.warn('⚠️ GEMINI_API_KEY no detectada. Usando fallback de análisis por reglas Regex.');
    return parseTransactionFallback(userText, isoDate);
  }

  const systemInstruction = `
Eres un asistente financiero personal de alta precisión. Tu tarea es extraer de manera estructurada los gastos, ingresos e inversiones a partir de los mensajes informales que el usuario envía por WhatsApp.

Contexto temporal:
${fullContext}

Moneda por defecto: "${config.defaultCurrency || 'EUR'}".

Reglas de extracción:
1. "esValido": Debe ser true únicamente si el usuario especifica un monto claro y un concepto identificable. Si solo saluda, es ambiguo o falta el monto numérico, devuelve false.
2. "tipo": Clasifica estrictamente en una de las siguientes 3 opciones:
   - "Gasto": Pagos, compras habituales, cuentas, consumos, servicios, salidas, etc.
   - "Ingreso": Sueldo, salarios, cobro por servicios, ventas, transferencias recibidas, etc.
   - "Inversión": Dinero destinado a inversión, brokers (ej: IOL, InvertirOnline, Balanz, Bull Market, Binance, etc.), compra de acciones, bonos, CEDEARs, criptomonedas (BTC, USDT, etc.), plazo fijo, fondos comunes de inversión (FCI), etc. NUNCA clasificar una inversión como "Gasto".
3. "monto": Número positivo (ej. 12.50, 1500, 800).
4. "moneda": Detecta la divisa especificada en el mensaje:
   - "EUR": si menciona "€", "eur", "euro", "euros" o si no se especifica divisa explícita (moneda predeterminada).
   - "USD": si menciona "$", "usd", "dolar", "dolares", "dólar", "dólares", "u$s", "us$".
   - "ARS": si menciona "ars", "peso", "pesos", "pesos argentinos".
5. "categoria": Clasifica estrictamente en una de las siguientes categorías en español:
   - "Inversión": Para cualquier tipo de inversión financiera, brokers, acciones, cripto, etc.
   - "Supermercado": Compras de comida y bebidas para casa, despensa, mercado, artículos de limpieza.
   - "Salidas": Restaurantes, bares, comidas afuera, cafés, delivery, cine, recitales, ocio.
   - "Viajes": Pasajes de avión, trenes, hoteles, alojamiento, turismo, vacaciones.
   - "Fijos": Alquiler, expensas, luz, agua, gas, internet, telefonía, suscripciones (Netflix, Spotify, etc.), seguros.
   - "Movilidad": Transporte diario (uber, cabify, taxi, colectivo, metro, tren), combustible/gasolina/nafta, peajes, estacionamiento.
   - "Articulo": Compras de bienes materiales, ropa, calzado, tecnología, muebles, farmacia/medicamentos, Amazon/tiendas.
   - "Otros": Únicamente si no encaja en las anteriores (ej. Ingresos generales).
6. "descripcion": Concepto claro y resumido (ej. "Almuerzo", "Uber a casa", "Compra zapatillas", "Inversión en IOL", "Cobro sueldo mensual").
7. "fecha": Formato YYYY-MM-DD. Si el mensaje menciona términos relativos como "ayer", "anteayer", o un día de la semana, calcula la fecha exacta en base al contexto temporal provisto. Si no se indica fecha, usa la fecha de hoy: "${isoDate}".
8. "motivoAclaracion": Si "esValido" es false, escribe un mensaje cordial y corto en español pidiendo los datos necesarios con ejemplos.
`.trim();

  try {
    const response = await client.models.generateContent({
      model: config.geminiModel,
      contents: userText,
      config: {
        systemInstruction,
        responseMimeType: 'application/json',
        responseJsonSchema: {
          type: Type.OBJECT,
          properties: {
            esValido: {
              type: Type.BOOLEAN,
              description: 'Indica si el mensaje contiene una transacción válida con monto.',
            },
            tipo: {
              type: Type.STRING,
              enum: ['Gasto', 'Ingreso', 'Inversión'],
              description: 'Tipo de transacción: Gasto, Ingreso o Inversión.',
            },
            monto: {
              type: Type.NUMBER,
              description: 'Valor numérico positivo de la transacción.',
            },
            moneda: {
              type: Type.STRING,
              enum: ['EUR', 'USD', 'ARS'],
              description: 'Moneda de la transacción: EUR, USD o ARS.',
            },
            categoria: {
              type: Type.STRING,
              enum: ['Inversión', 'Supermercado', 'Salidas', 'Viajes', 'Fijos', 'Movilidad', 'Articulo', 'Otros'],
              description: 'Categoría clasificada.',
            },
            descripcion: {
              type: Type.STRING,
              description: 'Breve detalle o concepto.',
            },
            fecha: {
              type: Type.STRING,
              description: 'Fecha en formato YYYY-MM-DD.',
            },
            motivoAclaracion: {
              type: Type.STRING,
              description: 'Mensaje amigable si no se pudo interpretar.',
            },
          },
          required: ['esValido'],
        },
      },
    });

    const rawJson = response.text?.trim() || '{}';
    const parsed = JSON.parse(rawJson);

    if (!parsed.esValido || !parsed.monto || !parsed.descripcion) {
      return {
        esValido: false,
        mensajeAclaracion:
          parsed.motivoAclaracion ||
          'No pude identificar el monto o el concepto de tu mensaje.\nPor favor indica el detalle y monto (ej: *Almuerzo 12.50 euros*, *Supermercado 50 usd* o *Nafta 15000 pesos*).',
      };
    }

    const validMoneda: CurrencyType = ['EUR', 'USD', 'ARS'].includes(parsed.moneda)
      ? (parsed.moneda as CurrencyType)
      : (config.defaultCurrency || 'EUR');

    const validTipo: TransactionType = ['Gasto', 'Ingreso', 'Inversión'].includes(parsed.tipo)
      ? (parsed.tipo as TransactionType)
      : 'Gasto';

    const transaction: Transaction = {
      fecha: parsed.fecha || isoDate,
      tipo: validTipo,
      categoria: parsed.categoria || 'Otros',
      descripcion: parsed.descripcion,
      monto: Math.abs(Number(parsed.monto)),
      moneda: validMoneda,
    };

    return {
      esValido: true,
      transaccion: transaction,
    };
  } catch (error) {
    console.error('Error al procesar mensaje con Gemini API:', error);
    // Intentar fallback si falla la API
    return parseTransactionFallback(userText, isoDate);
  }
}

/**
 * Fallback de contingencia mediante expresiones regulares cuando no hay conexión con LLM.
 */
export function parseTransactionFallback(text: string, defaultDate: string): ExtractionResult {
  const clean = text.trim();

  // 1. Detectar divisa: "EUR" | "USD" | "ARS" (por defecto EUR)
  let moneda: CurrencyType = config.defaultCurrency || 'EUR';
  if (/\b(ars|pesos?|pesos?\s*arg(?:entinos?)?)\b/i.test(clean)) {
    moneda = 'ARS';
  } else if (/\b(usd|d[oó]lar(?:es)?|u\$s|us\$)\b/i.test(clean)) {
    moneda = 'USD';
  } else if (/\b(eur|euros?|€)\b/i.test(clean)) {
    moneda = 'EUR';
  } else if (clean.includes('$')) {
    moneda = 'USD';
  }

  // 2. Extraer monto numérico (ej: 12.50, 12,50, 1500)
  const amountMatch = clean.match(/(?:[$€£]\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s*(?:[$€£]|eur(?:os?)?|usd|d[oó]lar(?:es)?|ars|pesos?|u\$s|us\$))?/i);
  if (!amountMatch) {
    return {
      esValido: false,
      mensajeAclaracion: '',
    };
  }

  const rawAmount = amountMatch[1].replace(',', '.');
  const monto = parseFloat(rawAmount);

  // 3. Extraer descripción limpiando monto y términos de divisa
  let description = clean
    .replace(amountMatch[0], '')
    .replace(/\b(eur|euros?|€|usd|d[oó]lar(?:es)?|u\$s|us\$|ars|pesos?|\$)\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (description.length < 2) {
    return {
      esValido: false,
      mensajeAclaracion: '⚠️ El mensaje contiene un monto pero falta el concepto o descripción (ej: *Cena 25 euros*).',
    };
  }

  const lower = clean.toLowerCase();

  // 4. Deducir Tipo: 'Gasto' | 'Ingreso' | 'Inversión'
  let tipo: TransactionType = 'Gasto';
  if (/\b(inversi[oó]n|invert[ií]|acciones|cedears?|cripto|bitcoin|btc|usdt|plazo fijo|bonos?|fci)\b/i.test(lower)) {
    tipo = 'Inversión';
  } else if (/\b(sueldo|salario|ingreso|cobro|cobr[eé]|honorarios|dep[oó]sito|venta|pago recibido)\b/i.test(lower)) {
    tipo = 'Ingreso';
  }

  // 5. Deducir Categoría: Supermercado, Salidas, Viajes, Fijos, Movilidad, Articulo, Otros
  let categoria = 'Otros';
  if (tipo === 'Inversión') {
    categoria = 'Inversión';
  } else if (tipo === 'Ingreso') {
    categoria = 'Ingresos';
  } else if (/\b(super|supermercado|mercadona|carrefour|dia|coto|despensa|almacen|verduleria|carniceria|compras casa)\b/i.test(lower)) {
    categoria = 'Supermercado';
  } else if (/\b(cena|almuerzo|desayuno|comida|restaurante|cafe|cafeteria|bar|cerveza|trago|delivery|pedidosya|glovo|mcdonalds|burger|pizza|salida|cine|recital|boliche|fiesta|merienda)\b/i.test(lower)) {
    categoria = 'Salidas';
  } else if (/\b(viaje|vuelo|avion|hotel|airbnb|hospedaje|pasaje|turismo|vacaciones|equipaje|alojamiento)\b/i.test(lower)) {
    categoria = 'Viajes';
  } else if (/\b(alquiler|expensas|luz|agua|gas|internet|wifi|netflix|spotify|telefono|seguro|cuota|suscripci[oó]n|patente)\b/i.test(lower)) {
    categoria = 'Fijos';
  } else if (/\b(uber|cabify|taxi|metro|subte|bus|colectivo|tren|nafta|gasolina|combustible|peaje|estacionamiento|cochera|movilidad)\b/i.test(lower)) {
    categoria = 'Movilidad';
  } else if (/\b(ropa|zapatillas|calzado|remera|pantalon|tecnologia|celular|computadora|farmacia|remedio|medicamento|libro|compra|amazon|articulo)\b/i.test(lower)) {
    categoria = 'Articulo';
  }

  // 6. Deducir Fecha
  let fecha = defaultDate;
  if (/\bayer\b/i.test(lower)) {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    fecha = yesterday.toISOString().split('T')[0];
  }

  return {
    esValido: true,
    transaccion: {
      fecha,
      tipo,
      categoria,
      descripcion: description.charAt(0).toUpperCase() + description.slice(1),
      monto,
      moneda,
    },
  };
}
