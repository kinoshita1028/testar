import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
export function loadShared() {
  const src = fs.readFileSync(path.join(here, '..', 'gas', 'Shared.gs'), 'utf8');
  return new Function(src + '\nreturn Shared;')();
}
