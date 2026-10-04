import fs from 'fs';
import { google, sheets_v4 } from 'googleapis';
import { config } from '../config/env.js';
import { Transaction } from '../types/transaction.js';

let sheetsClient: sheets_v4.Sheets | null = null;
let isHeaderVerified = false;
let isTableroVerified = false;
let isFormattingVerified = false;

// 7 columnas requeridas (sin Moneda Original)
const HEADERS = [
  'Fecha',
  'Tipo',
  'Categoría',
  'Descripción',
  'Monto EUR',
  'Monto USD',
  'Monto ARS',
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

  // 1. Intentar cargar desde JSON en variable de entorno
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

  // 2. Si no hay variable JSON directa, verificar archivo de credenciales
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
let activeSheetId: number | null = null;

/**
 * Obtiene el nombre real de la pestaña principal en la hoja de cálculo.
 */
async function resolveSheetDetails(sheets: sheets_v4.Sheets): Promise<{ title: string; sheetId: number }> {
  if (activeSheetName && activeSheetId !== null) {
    return { title: activeSheetName, sheetId: activeSheetId };
  }

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    const sheetList = meta.data.sheets || [];
    const titles = sheetList.map(s => s.properties?.title).filter((t): t is string => Boolean(t));

    let matchedSheet = sheetList.find(s => s.properties?.title === config.sheetName);
    if (!matchedSheet && sheetList.length > 0) {
      matchedSheet = sheetList.find(s => s.properties?.title?.toLowerCase() !== 'tablero') || sheetList[0];
    }

    activeSheetName = matchedSheet?.properties?.title || 'Hoja 1';
    activeSheetId = matchedSheet?.properties?.sheetId ?? 0;
  } catch (err: any) {
    activeSheetName = config.sheetName || 'Hoja 1';
    activeSheetId = 0;
  }

  return { title: activeSheetName, sheetId: activeSheetId };
}

/**
 * Verifica encabezados, elimina columna H obsoleta y aplica formato de tabla profesional.
 */
async function ensureHeadersAndTable(sheets: sheets_v4.Sheets): Promise<void> {
  if (isHeaderVerified) return;

  const { title: sheetName, sheetId } = await resolveSheetDetails(sheets);

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: config.spreadsheetId,
      range: `'${sheetName}'!A1:H1`,
    });

    const rows = response.data.values;
    // Si la hoja no tiene encabezados o tiene la columna H antigua de Moneda Original
    if (!rows || rows.length === 0 || rows[0].length !== HEADERS.length) {
      console.log(`ℹ️ Actualizando encabezados a 7 columnas en "${sheetName}"...`);
      await sheets.spreadsheets.values.update({
        spreadsheetId: config.spreadsheetId,
        range: `'${sheetName}'!A1:G1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [HEADERS],
        },
      });

      // Limpiar columna H si existía
      await sheets.spreadsheets.values.clear({
        spreadsheetId: config.spreadsheetId,
        range: `'${sheetName}'!H1:H1000`,
      });
    }

    // Aplicar formato de tabla (filtro, congelar encabezado, divisas y estilos)
    await applyTableFormatting(sheets, sheetId, sheetName);

    isHeaderVerified = true;
  } catch (error: any) {
    console.error('Error al verificar encabezados de Google Sheets:', error?.message || error);
  }
}

/**
 * Aplica formato de tabla nativo a la hoja de movimientos.
 */
async function applyTableFormatting(sheets: sheets_v4.Sheets, sheetId: number, sheetName: string): Promise<void> {
  if (isFormattingVerified) return;

  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: config.spreadsheetId });
    const sheetObj = meta.data.sheets?.find(s => s.properties?.sheetId === sheetId);
    const existingBandings = sheetObj?.bandedRanges || [];

    const requests: any[] = [];

    // Limpiar bandings previos para evitar duplicados
    for (const b of existingBandings) {
      if (b.bandedRangeId !== undefined) {
        requests.push({ deleteBanding: { bandedRangeId: b.bandedRangeId } });
      }
    }

    // Quitar y volver a aplicar filtro automático
    requests.push({ clearBasicFilter: { sheetId } });

    // Congelar fila 1 de encabezados
    requests.push({
      updateSheetProperties: {
        properties: {
          sheetId,
          gridProperties: { frozenRowCount: 1 },
        },
        fields: 'gridProperties.frozenRowCount',
      },
    });

    // Formato de moneda para Col E (EUR)
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 4, endColumnIndex: 5 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '[$€]#,##0.00' },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });

    // Formato de moneda para Col F (USD)
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 5, endColumnIndex: 6 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '[$US$ ]#,##0.00' },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });

    // Formato de moneda para Col G (ARS)
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 1, startColumnIndex: 6, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '[$ARS ]#,##0.00' },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });

    // Estilo visual del encabezado (Fila 1)
    requests.push({
      repeatCell: {
        range: { sheetId, startRowIndex: 0, endRowIndex: 1, startColumnIndex: 0, endColumnIndex: 7 },
        cell: {
          userEnteredFormat: {
            backgroundColor: { red: 0.07, green: 0.31, blue: 0.29 }, // Verde oscuro elegante
            textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
            horizontalAlignment: 'CENTER',
          },
        },
        fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
      },
    });

    // Añadir Banding (Zebra striping de tabla)
    requests.push({
      addBanding: {
        bandedRange: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 7 },
          rowProperties: {
            headerColor: { red: 0.07, green: 0.31, blue: 0.29 },
            firstBandColor: { red: 1, green: 1, blue: 1 },
            secondBandColor: { red: 0.95, green: 0.97, blue: 0.96 },
          },
        },
      },
    });

    // Activar filtro desplegable de tabla
    requests.push({
      setBasicFilter: {
        filter: {
          range: { sheetId, startRowIndex: 0, endRowIndex: 1000, startColumnIndex: 0, endColumnIndex: 7 },
        },
      },
    });

    // Añadir regla de validación de datos (desplegable) a la columna Tipo (Col B)
    requests.push({
      setDataValidation: {
        range: {
          sheetId,
          startRowIndex: 1, // Desde fila 2 (0-indexed)
          endRowIndex: 1000,
          startColumnIndex: 1, // Columna B
          endColumnIndex: 2,
        },
        rule: {
          condition: {
            type: 'ONE_OF_LIST',
            values: [
              { userEnteredValue: 'Gasto' },
              { userEnteredValue: 'Ingreso' },
              { userEnteredValue: 'Inversión' },
            ],
          },
          showCustomUi: true,
          strict: true,
        },
      },
    });

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests },
    });

    isFormattingVerified = true;
  } catch (error: any) {
    console.error('Error al aplicar formato de tabla:', error?.message || error);
  }
}

/**
 * Verifica si existe la pestaña 'Tablero'; si no existe, la crea con tablas y fórmulas automáticas.
 */
export async function ensureTablero(sheets: sheets_v4.Sheets): Promise<void> {
  if (isTableroVerified) return;

  const { title: sheetName } = await resolveSheetDetails(sheets);

  try {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    const sheetList = meta.data.sheets || [];
    let tableroSheet = sheetList.find(s => s.properties?.title?.toLowerCase() === 'tablero');

    if (!tableroSheet) {
      console.log('ℹ️ Creando pestaña "Tablero" con fórmulas de resumen...');
      const createRes = await sheets.spreadsheets.batchUpdate({
        spreadsheetId: config.spreadsheetId,
        requestBody: {
          requests: [
            {
              addSheet: {
                properties: {
                  title: 'Tablero',
                  gridProperties: {
                    rowCount: 50,
                    columnCount: 10,
                  },
                },
              },
            },
          ],
        },
      });

      const newId = createRes.data.replies?.[0]?.addSheet?.properties?.sheetId ?? 876614476;
      await populateTablero(sheets, sheetName, newId);
      console.log('✅ Pestaña "Tablero" configurada exitosamente.');
    } else {
      const tableroId = tableroSheet.properties?.sheetId ?? 876614476;
      await formatTablero(sheets, tableroId);
    }
    isTableroVerified = true;
  } catch (error: any) {
    console.error('Error al verificar/crear pestaña Tablero:', error?.message || error);
  }
}

/**
 * Escribe las tablas y fórmulas de Google Sheets en la pestaña 'Tablero'.
 */
async function populateTablero(sheets: sheets_v4.Sheets, sheetName: string, tableroId: number): Promise<void> {
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

  // Filas de categorías para el mes actual
  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    values.push([
      cat,
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}", ${s}!$A:$A, ">="&${dateFrom}, ${s}!$A:$A, "<="&${dateTo})`,
    ]);
  }

  values.push([
    'TOTAL GASTOS DEL MES',
    '=SUM(B12:B18)',
    '=SUM(C12:C18)',
    '=SUM(D12:D18)',
  ]);

  // Resumen Histórico Total
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

  for (let i = 0; i < CATEGORIES.length; i++) {
    const cat = CATEGORIES[i];
    values.push([
      cat,
      `=SUMIFS(${s}!$E:$E, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}")`,
      `=SUMIFS(${s}!$F:$F, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}")`,
      `=SUMIFS(${s}!$G:$G, ${s}!$B:$B, "Gasto", ${s}!$C:$C, "${cat}")`,
    ]);
  }

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

  await formatTablero(sheets, tableroId);
}

/**
 * Aplica formato visual de tablas y divisas a la pestaña 'Tablero'.
 */
async function formatTablero(sheets: sheets_v4.Sheets, tableroId: number): Promise<void> {
  try {
    const requests: any[] = [];

    // Divisas en columnas B (EUR), C (USD) y D (ARS)
    requests.push({
      repeatCell: {
        range: { sheetId: tableroId, startRowIndex: 3, endRowIndex: 40, startColumnIndex: 1, endColumnIndex: 2 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '[$€]#,##0.00' },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });

    requests.push({
      repeatCell: {
        range: { sheetId: tableroId, startRowIndex: 3, endRowIndex: 40, startColumnIndex: 2, endColumnIndex: 3 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '[$US$ ]#,##0.00' },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });

    requests.push({
      repeatCell: {
        range: { sheetId: tableroId, startRowIndex: 3, endRowIndex: 40, startColumnIndex: 3, endColumnIndex: 4 },
        cell: {
          userEnteredFormat: {
            numberFormat: { type: 'CURRENCY', pattern: '[$ARS ]#,##0.00' },
            horizontalAlignment: 'RIGHT',
          },
        },
        fields: 'userEnteredFormat(numberFormat,horizontalAlignment)',
      },
    });

    // Encabezados de tablas en Tablero (Filas 4, 11, 22, 29)
    const headerRows = [3, 10, 21, 28];
    for (const hr of headerRows) {
      requests.push({
        repeatCell: {
          range: { sheetId: tableroId, startRowIndex: hr, endRowIndex: hr + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.12, green: 0.22, blue: 0.35 },
              textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 }, bold: true, fontSize: 10 },
              horizontalAlignment: 'CENTER',
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat,horizontalAlignment)',
        },
      });
    }

    // Títulos de secciones en Tablero
    const titleRows = [0, 9, 20, 27];
    for (const tr of titleRows) {
      requests.push({
        repeatCell: {
          range: { sheetId: tableroId, startRowIndex: tr, endRowIndex: tr + 1, startColumnIndex: 0, endColumnIndex: 4 },
          cell: {
            userEnteredFormat: {
              backgroundColor: { red: 0.91, green: 0.94, blue: 0.98 },
              textFormat: { bold: true, fontSize: 11, foregroundColor: { red: 0.05, green: 0.15, blue: 0.3 } },
            },
          },
          fields: 'userEnteredFormat(backgroundColor,textFormat)',
        },
      });
    }

    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: config.spreadsheetId,
      requestBody: { requests },
    });
  } catch (err: any) {
    console.error('Error al aplicar estilos a Tablero:', err?.message || err);
  }
}

/**
 * Agrega un nuevo movimiento financiero a la hoja de Google Sheets.
 * Guarda el monto original en su divisa e inserta fórmulas nativas de GoogleFinance
 * para autoconvertir en tiempo real a las divisas restantes.
 */
export async function appendTransaction(tx: Transaction): Promise<void> {
  if (!config.spreadsheetId) {
    throw new Error('SPREADSHEET_ID no está configurado en las variables de entorno.');
  }

  const sheets = await getSheetsClient();
  await ensureHeadersAndTable(sheets);
  await ensureTablero(sheets);
  const { title: sheetName } = await resolveSheetDetails(sheets);

  // Obtener el número de fila real donde se insertará el nuevo registro
  const countRes = await sheets.spreadsheets.values.get({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:A`,
  });
  const nextRow = (countRes.data.values?.length || 1) + 1;

  // Asignar monto a su moneda y fórmulas dinámicas de conversión a las restantes
  let montoEUR: string | number = '';
  let montoUSD: string | number = '';
  let montoARS: string | number = '';

  if (tx.moneda === 'EUR') {
    montoEUR = tx.monto;
    montoUSD = `=IFERROR(ROUND(E${nextRow}*GOOGLEFINANCE("CURRENCY:EURUSD"), 2), "")`;
    montoARS = `=IFERROR(ROUND(E${nextRow}*GOOGLEFINANCE("CURRENCY:EURARS"), 2), "")`;
  } else if (tx.moneda === 'USD') {
    montoEUR = `=IFERROR(ROUND(F${nextRow}*GOOGLEFINANCE("CURRENCY:USDEUR"), 2), "")`;
    montoUSD = tx.monto;
    montoARS = `=IFERROR(ROUND(F${nextRow}*GOOGLEFINANCE("CURRENCY:USDARS"), 2), "")`;
  } else if (tx.moneda === 'ARS') {
    montoEUR = `=IFERROR(ROUND(G${nextRow}/GOOGLEFINANCE("CURRENCY:EURARS"), 2), "")`;
    montoUSD = `=IFERROR(ROUND(G${nextRow}/GOOGLEFINANCE("CURRENCY:USDARS"), 2), "")`;
    montoARS = tx.monto;
  }

  const rowValues = [
    tx.fecha,        // Col A: Fecha (YYYY-MM-DD)
    tx.tipo,         // Col B: Gasto | Ingreso | Inversión
    tx.categoria,    // Col C: Categoría
    tx.descripcion,  // Col D: Concepto / Detalle
    montoEUR,        // Col E: Monto EUR
    montoUSD,        // Col F: Monto USD
    montoARS,        // Col G: Monto ARS
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: config.spreadsheetId,
    range: `'${sheetName}'!A:G`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: {
      values: [rowValues],
    },
  });

  console.log(
    `[Google Sheets] ✅ Fila ${nextRow} agregada: ${tx.fecha} | ${tx.tipo} | ${tx.categoria} | ${tx.descripcion} | ${tx.monto} ${tx.moneda}`
  );
}
