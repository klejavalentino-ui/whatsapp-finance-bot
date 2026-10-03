import { getSheetsClient } from '../src/services/sheets.js';
import { config } from '../src/config/env.js';

async function check() {
  console.log(`Comprobando acceso a Google Sheets con ID: ${config.spreadsheetId}`);
  try {
    const sheets = await getSheetsClient();
    const meta = await sheets.spreadsheets.get({
      spreadsheetId: config.spreadsheetId,
    });
    console.log(`✅ ¡Conexión exitosa! Título del documento: "${meta.data.properties?.title}"`);
    const sheetTitles = (meta.data.sheets || []).map(s => s.properties?.title);
    console.log(`📋 Pestañas encontradas:`, sheetTitles);
  } catch (err: any) {
    if (err?.code === 403 || err?.code === 404 || err?.message?.includes('caller does not have permission')) {
      console.error(`❌ Permiso denegado: Asegúrate de haber compartido la hoja con el correo de la cuenta de servicio con rol de Editor.`);
    } else {
      console.error('Error al conectar:', err?.message || err);
    }
  }
}

check();
