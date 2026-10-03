import dotenv from 'dotenv';
import path from 'path';

// Cargar variables de entorno desde .env
dotenv.config();

export interface Config {
  geminiApiKey: string;
  geminiModel: string;
  allowedPhoneNumber: string;
  spreadsheetId: string;
  sheetName: string;
  googleCredentialsPath: string;
  googleServiceAccountJson?: string;
  whatsappAuthDir: string;
  currencySymbol: string;
}

function getEnv(key: string, defaultValue?: string): string {
  const value = process.env[key] ?? defaultValue;
  if (value === undefined) {
    throw new Error(`[Config Error] Falta la variable de entorno obligatoria: ${key}`);
  }
  return value;
}

export const config: Config = {
  geminiApiKey: process.env.GEMINI_API_KEY || '',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.8-flash',
  allowedPhoneNumber: (process.env.ALLOWED_PHONE_NUMBER || '').replace(/\D/g, ''),
  spreadsheetId: process.env.SPREADSHEET_ID || '',
  sheetName: process.env.SHEET_NAME || 'Movimientos',
  googleCredentialsPath: path.resolve(
    process.cwd(),
    process.env.GOOGLE_APPLICATION_CREDENTIALS || './credentials/service-account.json'
  ),
  googleServiceAccountJson: process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
  whatsappAuthDir: path.resolve(
    process.cwd(),
    process.env.WHATSAPP_AUTH_DIR || './auth_session'
  ),
  currencySymbol: process.env.CURRENCY_SYMBOL || '$',
};

export function validateCoreConfig(): void {
  const missing: string[] = [];

  if (!config.spreadsheetId) missing.push('SPREADSHEET_ID');
  if (!config.allowedPhoneNumber) missing.push('ALLOWED_PHONE_NUMBER');
  
  if (missing.length > 0) {
    console.warn(`\n⚠️  ATENCIÓN: Variables críticas ausentes en .env: ${missing.join(', ')}`);
    console.warn(`   Revisa tu archivo .env antes de comenzar el registro en producción.\n`);
  }
}
