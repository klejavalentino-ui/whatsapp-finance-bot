import fs from 'fs';
import { google, sheets_v4 } from 'googleapis';
import { config } from '../config/env.js';
import { Transaction } from '../types/transaction.js';

let sheetsClient: sheets_v4.Sheets | null = null;
let isHeaderVerified = false;
let isTableroVerified = false;

// 8 columnas requeridas para soporte multidivisa
const HEADERS = [
  'Fecha',
  'Tipo',
  'Categoría',
  'Descripción',
  'Monto EUR',
  'Monto USD',
  'Monto ARS',
  'Moneda Original',
];

const CATEGORIES = [
  'Supermercado',
  'Salidas',
  'Viajes',
  'Fijos',
  'Movilidad',
  'Articulo',
  'Otros',
];

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
      // Si no existe, usa la primera pestaña encontrada que no sea Tablero
      const candidate = titles.find(t => t.toLowerCase() !== 'tablero') || titles[0];
      activeSheetName = candidate;
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
 * Verifica si la hoja de registros existe y actualiza los encabezados si es necesario.
 */
async function ensureHeaders(sheets: sheets_v4.Sheets): Promise<void> {
  if (isHeaderVerified) return;

  const sheetName = await resolveSheetName(sheets);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A1:H1`,
    });

    const rows = response.data.values;
    // Si la hoja está vacía o tiene menos de 8 encabezados (la versión anterior tenía 5)
    if (!rows || rows.length === 0 || rows[0].length < HEADERS.length) {
      console.log(`ℹ️ Actualizando encabezados a formato multidivisa en pestaña "${sheetName}"...`);
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${sheetName}'!A1:H1`,
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
 * Verifica si existe la pestaña 'Tablero'; si no existe, la crea con fórmulas automáticas para resúmenes.
 */
export async function ensureTablero(sheets: sheets_v4.Sheets): Promise<void> {
  if (isTableroVerified) return;

  const sheetName = await resolveSheetName(sheets);

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    const sheetList = meta.data.sheets || [];
    const exists = sheetList.some(s => s.properties?.title?.toLowerCase() === 'tablero');

    if (!exists) {
      console.log('ℹ️ Creando pestaña "Tablero" con fórmulas de resumen...');
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: 'Tablero',
                  gridProperties: {
                    rowCount: 45,
                    columnCount: 10,
                  },
                },
              },
            },
          ],
        },
      });

      await populateTablero(sheets, sheetName);
      console.log('✅ Pestaña "Tablero" configurada exitosamente.');
    }
    isTableroVerified = true;
  } catch (error: any) {
    console.error('Error al verificar/crear pestaña Tablero:', error?.message || error);
  }
}

/**
 * Escribe las tablas y fórmulas de Google Sheets en la pestaña 'Tablero'.
 */
async function populateTablero(sheets: sheets_v4.Sheets, sheetName: string): Promise<void> {
  // Construcción de la matriz de celdas para el Tablero
  const s = `'${sheetName}'`;

  // Fórmulas para el mes en curso usando SUMIFS
  const dateFrom = `TEXT(DATE(YEAR(TODAY()), MONTH(TODAY()), 1), "yyyy-mm-dd")`;
  const dateTo = `TEXT(EOMONTH(TODAY(), 0), "yyyy-mm-dd")`;

  const values: (string | number)[][] = [
    ['📊 TABLERO FINANCIERO - RESUMEN DEL MES EN CURSO', '', '', ''],
    ['Mes:', `="Mes actual (" & TEXT(TODAY(), "mmmm yyyy") & ")"`, '', ''],
    ['', '', '', ''],
    ['Flujo / Tipo', 'Total EUR (€)', 'Total USD ($)', 'Total ARS ($)'],
    [
      'Ingreso',
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Ingreso", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Ingreso", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Ingreso", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
    ],
    [
      'Gasto',
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Gasto", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Gasto", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Gasto", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
    ],
    [
      'Inversión',
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Inversión", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Inversión", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Inversión", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
    ],
    [
      'Balance Neto (Ingresos - Gastos)',
      '=B5-B6',
      '=C5-C6',
      '=D5-D6',
    ],
    ['', '', '', ''],
    ['🏷️ DESGLOSE DE GASTOS POR CATEGORÍA (Mes Actual)', '', '', ''],
    ['Categoría', 'Gasto EUR (€)', 'Gasto USD ($)', 'Gasto ARS ($)'],
  ];

  // Agregar filas de categorías para el mes actual
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    values.push([
      cat,
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
    ]);
  }

  // Fila de Total de Gastos del Mes
  values.push([
    'TOTAL GASTOS DEL MES',
    '=SUM(B12:B18)',
    '=SUM(C12:C18)',
    '=SUM(D12:D18)',
  ]);

  // Sección de Resumen Histórico Total
  values.push(
    ['', '', '', ''],
    ['📈 RESUMEN HISTÓRICO TOTAL (Acumulado General)', '', '', ''],
    ['Concepto', 'Total EUR (€)', 'Total USD ($)', 'Total ARS ($)'],
    [
      'Total Ingresos',
      `=SUMIF(${s}!$B:$B, "Ingreso", ${s}!$E:$E)`,
      `=SUMIF(${s}!$B:$B, "Ingreso", ${s}!$F:$F)`,
      `=SUMIF(${s}!$B:$B, "Ingreso", ${s}!$G:$G)`,
    ],
    [
      'Total Gastos',
      `=SUMIF(${s}!$B:$B, "Gasto", ${s}!$E:$E)`,
      `=SUMIF(${s}!$B:$B, "Gasto", ${s}!$F:$F)`,
      `=SUMIF(${s}!$B:$B, "Gasto", ${s}!$G:$G)`,
    ],
    [
      'Total Inversiones',
      `=SUMIF(${s}!$B:$B, "Inversión", ${s}!$E:$E)`,
      `=SUMIF(${s}!$B:$B, "Inversión", ${s}!$F:$F)`,
      `=SUMIF(${s}!$B:$B, "Inversión", ${s}!$G:$G)`,
    ],
    [
      'Balance Histórico Neto',
      '=B23-B24',
      '=C23-C24',
      '=D23-D24',
    ],
    ['', '', '', ''],
    ['🏷️ DESGLOSE DE GASTOS HISTÓRICO (Total Acumulado)', '', '', ''],
    ['Categoría', 'Total EUR (€)', 'Total USD ($)', 'Total ARS ($)']
  );

  // Agregar filas de categorías para histórico total
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    values.push([
      cat,
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}")`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}")`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}")`,
    ]);
  }

  // Fila de Total Histórico de Gastos
  values.push([
    'TOTAL HISTÓRICO GASTOS',
    '=SUM(B30:B36)',
    '=SUM(C30:C36)',
    '=SUM(D30:D36)',
  ]);

  await sheets.spreadsheets.values.update({
    spreadsheetId: config.spreadsheetId,
    range: `'Tablero'!A1:D${values.length}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: {
      values,
    },
  });
}

/**
 * Agrega un nuevo movimiento financiero a la hoja de Google Sheets en formato multidivisa.
 */
export async function appendTransaction(tx: Transaction): Promise<void> {
  if (!config.spreadsheetId) {
    throw new Error('SPREADSHEET_ID no está configurado en las variables de entorno.');
  }

  const sheets = await getSheetsClient();
  await ensureHeaders(sheets);
  await ensureTablero(sheets);
  const sheetName = await resolveSheetName(sheets);

  // Mapear monto a la columna de divisa correspondiente
  const montoEUR = tx.moneda === 'EUR' ? tx.monto : '';
  const montoUSD = tx.moneda === 'USD' ? tx.monto : '';
  const montoARS = tx.moneda === 'ARS' ? tx.monto : '';

  const rowValues = [
    tx.fecha,        // Col A: Fecha (YYYY-MM-DD)
    tx.tipo,         // Col B: Gasto | Ingreso | Inversión
    tx.categoria,    // Col C: Categoría (Supermercado, Salidas, etc.)
    tx.descripcion,  // Col D: Concepto / Detalle
    montoEUR,        // Col E: Monto EUR
    montoUSD,        // Col F: Monto USD
    montoARS,        // Col G: Monto ARS
    tx.moneda,       // Col H: Moneda Original
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [rowValues],
    },
  });

  console.log(
    `[Google Sheets] ✅ Fila agregada: ${tx.fecha} | ${tx.tipo} | ${tx.categoria} | ${tx.descripcion} | ${tx.monto} ${tx.moneda}`
  );
}
