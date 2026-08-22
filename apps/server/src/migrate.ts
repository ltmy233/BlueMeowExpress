import { loadConfig } from './config.js';
import { openDatabase } from './db.js';

const db = openDatabase(loadConfig().databasePath);
db.close();
console.log('Migrations applied');
