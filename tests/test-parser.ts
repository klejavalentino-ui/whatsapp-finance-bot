import { parseTransactionFallback } from '../src/services/ai.js';

console.log('--- Probando parseTransactionFallback ---');

const testCases = [
  'Almuerzo 12.50',
  'Cobro sueldo 1500',
  'Uber 800 transporte ayer',
  'Hola, buenas tardes',
  '120.00',
];

for (const input of testCases) {
  const result = parseTransactionFallback(input, '2026-10-02');
  console.log(`\nInput: "${input}"`);
  console.log('Resultado:', JSON.stringify(result, null, 2));
}
