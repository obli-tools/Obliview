import './config.js'; // validates env vars on import
import { connect } from './wsClient.js';

console.log('Obliview Proxy Stub v1.0.0');
console.log(`Server: ${process.env.OBLIVIEW_SERVER || 'http://localhost:3001'}`);
console.log(`UUID: ${process.env.DEVICE_UUID || '(auto-generated)'}`);

connect();

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('Shutting down...');
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('Shutting down...');
  process.exit(0);
});
