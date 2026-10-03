import fs from 'fs';
import { google, sheets_v4 } from 'googleapis';
import { config } from '../config/env.js';
import { Transaction } from '../types/transaction.js';

let sheetsClient: sheets_v4.Sheets | null = null;
let isHeaderVerified = false;

const HEADERS = ['Fecha', 'Tipo', 'Categoría', 'Descripción', 'Monto'];

/**
 * Inicializa y devuelve la instancia autenticada de Google Sheets API.
 */
export async function getSheetsClient(): Promise<sheets_v4.Sheets> {
  if (sheetsClient) {
    return sheetsClient;
  }

  let auth;

  // 1. Intentar cargar desde JSON en variable de entorno (ideal para Docker o PaaS)
  if (config.googleServiceAccountJson) {
    try {
      const credentials = JSON.parse(config.googleServiceAccountJson);
      auth = new google.auth.GoogleAuth({
        credentials,
        scopes: ['https://www.googleapis.com/auth/spreadsheets'],
      });
    } catch (err) {
      console.error('Error al parsear GOOGLE_SERVICE_ACCOUNT_JSON:', err);
    }
  }

  // 2. Si no hay variable JSON directa, verificar si existe el archivo de credenciales
  if (!auth) {
    if (!fs.existsSync(config.googleCredentialsPath)) {
      throw new Error(
        `No se encontró el archivo de credenciales de Google Cloud en: ${config.googleCredentialsPath}.\n` +
        `Por favor asegúrate de descargarlo desde Google Cloud Console o especificar GOOGLE_SERVICE_ACCOUNT_JSON.`
      );
    }

    auth = new google.auth.GoogleAuth({
      keyFile: config.googleCredentialsPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  sheetsClient = google.sheets({ version: 'v4', auth });
  return sheetsClient;
}

let activeSheetName: string | null = null;

/**
 * Obtiene el nombre real de la pestaña en la hoja de cálculo o usa la primera pestaña encontrada.
 */
async function resolveSheetName(sheets: sheets_v4.Sheets): Promise<string> {
  if (activeSheetName) return activeSheetName;

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    const sheetList = meta.data.sheets || [];
    const titles = sheetList.map(s => s.properties?.title).filter((t): t is string => Boolean(t));

    // Si la pestaña configurada existe, úsala
    if (titles.includes(config.sheetName)) {
      activeSheetName = config.sheetName;
    } else if (titles.length > 0) {
      // Si no existe, usa la primera pestaña encontrada (ej. "Hoja 1" o "Sheet1")
      activeSheetName = titles[0];
      console.log(`ℹ️ Pestaña "${config.sheetName}" no encontrada. Usando la pestaña principal: "${activeSheetName}"`);
    } else {
      activeSheetName = config.sheetName;
    }
  } catch (err: any) {
    activeSheetName = config.sheetName;
  }

  return activeSheetName;
}

/**
 * Verifica si la hoja existe y si tiene los encabezados correctos; si no, los crea.
 */
async function ensureHeaders(sheets: sheets_v4.Sheets): Promise<void> {
  if (isHeaderVerified) return;

  const sheetName = await resolveSheetName(sheets);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A1:E1`,
    });

    const rows = response.data.values;
    if (!rows || rows.length === 0 || rows[0].length === 0) {
      console.log(`ℹ️ Pestaña "${sheetName}" vacía. Insertando encabezados estándar...`);
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${sheetName}'!A1:E1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [HEADERS],
        },
      });
    }
    isHeaderVerified = true;
  } catch (error: any) {
    console.error('Error al verificar encabezados de Google Sheets:', error?.message || error);
  }
}

/**
 * Agrega un nuevo movimiento financiero a la hoja de Google Sheets.
 */
export async function appendTransaction(tx: Transaction): Promise<void> {
  if (!config.spreadsheetId) {
    throw new Error('SPREADSHEET_ID no está configurado en las variables de entorno.');
  }

  const sheets = await getSheetsClient();
  await ensureHeaders(sheets);
  const sheetName = await resolveSheetName(sheets);

  const rowValues = [
    tx.fecha,        // Fecha (YYYY-MM-DD)
    tx.tipo,         // Gasto o Ingreso
    tx.categoria,    // Categoría
    tx.descripcion,  // Concepto
    tx.monto,        // Monto numérico
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:E`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [rowValues],
    },
  });

  console.log(`[Google Sheets] ✅ Fila agregada: ${tx.fecha} | ${tx.tipo} | ${tx.categoria} | ${tx.descripcion} | ${tx.monto}`);
}
