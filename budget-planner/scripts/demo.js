// Cross-platform `npm run demo` (works in Windows cmd/PowerShell too):
// seeds demo data into ./demo-data and starts the server on it.
process.env.DATA_DIR ||= 'demo-data';
await import('./seed-demo.js');
await import('../server.js');
