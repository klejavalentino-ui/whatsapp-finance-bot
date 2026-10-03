import { GoogleGenAI, Type } from '@google/genai';
import { config } from '../config/env.js';
import { ExtractionResult, Transaction, TransactionType } from '../types/transaction.js';

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
Eres un asistente financiero personal de alta precisión. Tu tarea es extraer de manera estructurada los gastos e ingresos a partir de los mensajes informales que el usuario envía por WhatsApp.

Contexto temporal:
${fullContext}

Reglas de extracción:
1. "esValido": Debe ser true únicamente si el usuario especifica un monto claro y un concepto identificable. Si solo saluda, es ambiguo o falta el monto numérico, devuelve false.
2. "tipo": Determina si es "Gasto" (lo habitual: compras, comida, pagos, ubers, cuentas) o "Ingreso" (sueldo, cobro, venta, depósito, honorarios, etc.).
3. "monto": Número positivo (ej. 12.50, 1500, 800).
4. "categoria": Clasifica en una categoría estándar y concisa en español (ej. "Comida", "Transporte", "Servicios", "Sueldo", "Ocio", "Salud", "Hogar", "Supermercado", "Educación", "Transferencia", "Otros"). Si el usuario la menciona explícitamente, respétala. Si no, dedúcela del concepto.
5. "descripcion": Concepto claro y resumido (ej. "Almuerzo", "Uber a casa", "Cobro sueldo mensual").
6. "fecha": Formato YYYY-MM-DD. Si el mensaje menciona términos relativos como "ayer", "anteayer", o un día de la semana, calcula la fecha exacta en base al contexto temporal provisto. Si no se indica fecha, usa la fecha de hoy: "${isoDate}".
7. "motivoAclaracion": Si "esValido" es false, escribe un mensaje cordial y corto en español pidiendo los datos necesarios con ejemplos.
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
              enum: ['Gasto', 'Ingreso'],
              description: 'Gasto o Ingreso.',
            },
            monto: {
              type: Type.NUMBER,
              description: 'Valor numérico de la transacción.',
            },
            categoria: {
              type: Type.STRING,
              description: 'Categoría deducida o explícita.',
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
          'No pude identificar el monto o el concepto de tu mensaje.\nPor favor indica el detalle y monto (ej: *Almuerzo 12.50* o *Cobro sueldo 1500*).',
      };
    }

    const transaction: Transaction = {
      fecha: parsed.fecha || isoDate,
      tipo: parsed.tipo === 'Ingreso' ? 'Ingreso' : 'Gasto',
      categoria: parsed.categoria || 'Otros',
      descripcion: parsed.descripcion,
      monto: Math.abs(Number(parsed.monto)),
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
  
  // Buscar montos: $12.50, 12,50, 1500, etc.
  const amountMatch = clean.match(/(?:[$€£]\s*)?(\d+(?:[.,]\d{1,2})?)(?:\s*[$€£])?/);
  if (!amountMatch) {
    return {
      esValido: false,
      mensajeAclaracion:
        '⚠️ No encontré ningún monto numérico en tu mensaje.\n' +
        'Por favor envía algo como:\n' +
        '👉 *Almuerzo 12.50*\n' +
        '👉 *Cobro sueldo 1500*\n' +
        '👉 *Uber 800 transporte ayer*',
    };
  }

  const rawAmount = amountMatch[1].replace(',', '.');
  const monto = parseFloat(rawAmount);

  // Quitar el número del texto para obtener la descripción
  const description = clean.replace(amountMatch[0], '').replace(/\s+/g, ' ').trim();
  if (description.length < 2) {
    return {
      esValido: false,
      mensajeAclaracion: '⚠️ El mensaje contiene un monto pero falta el concepto o descripción (ej: *Cena 25*).',
    };
  }

  const lower = description.toLowerCase();
  
  // Deducir Tipo
  const isIncome = /\b(sueldo|ingreso|cobro|cobre|honorarios|deposito|venta|pago recibido)\b/i.test(lower);
  const tipo: TransactionType = isIncome ? 'Ingreso' : 'Gasto';

  // Deducir Categoría
  let categoria = 'Otros';
  if (isIncome) {
    categoria = 'Sueldo/Ingresos';
  } else if (/\b(almuerzo|cena|desayuno|comida|restaurante|cafe|super|supermercado|burger|pizza)\b/i.test(lower)) {
    categoria = 'Comida';
  } else if (/\b(uber|taxi|cabify|metro|bus|colectivo|gasolina|nafta|peaje|transporte)\b/i.test(lower)) {
    categoria = 'Transporte';
  } else if (/\b(luz|agua|gas|internet|wifi|netflix|spotify|telefono|alquiler|expensas|servicios)\b/i.test(lower)) {
    categoria = 'Servicios';
  } else if (/\b(cine|salida|bar|cerveza|juego|fiesta|concierto)\b/i.test(lower)) {
    categoria = 'Ocio';
  } else if (/\b(farmacia|medico|doctor|remedio|salud|dentista)\b/i.test(lower)) {
    categoria = 'Salud';
  }

  // Deducir Fecha
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
    },
  };
}
