import { parseTransactionFallback } from '../src/services/ai.js';

console.log('==============================================');
console.log('🧪 Probando Parser Fallback con Divisas y Tipos');
console.log('==============================================\n');

const testCases = [
  'Cena 4 euros',
  'Supermercado 45.20 eur',
  'Vuelo a Madrid 120 usd',
  'Nafta 15000 pesos',
  'Alquiler 400 u$s',
  'Compra zapatillas 85€',
  'Inversión 500 usd en cripto',
  'Cobro sueldo 2500 eur',
  'Café 1.50',
  'Uber 2500 ars ayer',
];

for (const input of testCases) {
  const result = parseTransactionFallback(input, '2026-10-03');
  console.log(`Input: "${input}"`);
  console.log('  -> Válido:', result.esValido);
  if (result.transaccion) {
    const t = result.transaccion;
    console.log(`  -> Tipo: ${t.tipo} | Monto: ${t.monto} ${t.moneda} | Cat: ${t.categoria} | Desc: "${t.descripcion}" | Fecha: ${t.fecha}`);
  } else {
    console.log(`  -> Aclaración: ${result.mensajeAclaracion}`);
  }
  console.log('---');
}
