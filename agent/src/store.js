// STRETCH: remembers the last media folder and last selected device across restarts.
import fs from 'node:fs';
import path from 'node:path';

export function createStore(file) {
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}
  return {
    get: (key) => data[key],
    set(key, value) {
      data[key] = value;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data, null, 2));
      } catch (err) {
        console.warn(`[store] could not save ${file}: ${err.message}`);
      }
    },
  };
}
