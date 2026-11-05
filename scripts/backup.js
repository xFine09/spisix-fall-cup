// Copia manual de la base de datos en data/backups (la web ya hace una al día sola).
// En local: npm run backup · Con Docker: docker compose exec web node scripts/backup.js
import { backup } from '../server/db.js';

console.log('Copia guardada en', backup({ withTime: true }));
