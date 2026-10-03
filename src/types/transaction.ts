export type TransactionType = 'Gasto' | 'Ingreso';

export interface Transaction {
  fecha: string;        // Formato YYYY-MM-DD
  tipo: TransactionType; // 'Gasto' | 'Ingreso'
  categoria: string;    // Ej. 'Comida', 'Transporte', 'Sueldo', etc.
  descripcion: string;  // Detalle o concepto de la transacción
  monto: number;        // Monto positivo
}

export interface ExtractionResult {
  esValido: boolean;
  transaccion?: Transaction;
  mensajeAclaracion?: string;
}
