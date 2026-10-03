export type TransactionType = 'Gasto' | 'Ingreso' | 'Inversión';
export type CurrencyType = 'EUR' | 'USD' | 'ARS';

export interface Transaction {
  fecha: string;        // Formato YYYY-MM-DD
  tipo: TransactionType; // 'Gasto' | 'Ingreso' | 'Inversión'
  categoria: string;    // 'Supermercado' | 'Salidas' | 'Viajes' | 'Fijos' | 'Movilidad' | 'Articulo' | 'Otros'
  descripcion: string;  // Detalle o concepto de la transacción
  monto: number;        // Monto numérico positivo
  moneda: CurrencyType; // 'EUR' | 'USD' | 'ARS'
}

export interface ExtractionResult {
  esValido: boolean;
  transaccion?: Transaction;
  mensajeAclaracion?: string;
}

