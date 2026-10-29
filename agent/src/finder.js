// Native macOS file/folder pickers. The dialog opens on the Mac's own screen
// (via osascript), so these are for when you're sitting at the Mac.
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { AgentError } from './upnp.js';

let open = false;

const asString = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/** Resolves to the chosen POSIX path, or null if the user cancelled. */
export function chooseInFinder({ kind, defaultDir }) {
  if (process.platform !== 'darwin') throw new AgentError('NOT_SUPPORTED', 'The Finder picker only works when the agent runs on macOS');
  if (open) throw new AgentError('PICKER_BUSY', 'A Finder dialog is already open on the Mac');

  const where = defaultDir && fs.existsSync(defaultDir) ? ` default location (POSIX file ${asString(defaultDir)})` : '';
  const choose =
    kind === 'folder'
      ? `choose folder with prompt "Choose the media folder to cast from"${where}`
      : `choose file with prompt "Choose a video or audio file to cast" of type {"public.movie", "public.audio"}${where}`;
  // `activate` brings the dialog in front of other windows.
  const script = ['activate', `set picked to ${choose}`, 'POSIX path of picked'];

  open = true;
  return new Promise((resolve, reject) => {
    execFile('osascript', script.flatMap((line) => ['-e', line]), (err, stdout, stderr) => {
      open = false;
      if (!err) return resolve(stdout.trim());
      if (/-128/.test(stderr)) return resolve(null); // "User canceled."
      reject(new AgentError('PICKER_FAILED', `Could not open the Finder dialog: ${stderr.trim() || err.message}`));
    });
  });
}
