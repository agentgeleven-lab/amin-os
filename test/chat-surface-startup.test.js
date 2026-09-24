import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

for (const mode of ['success', 'failure']) test(`Tauri surface startup waits for participant imports: ${mode}`, () => {
    execFileSync(process.execPath, ['--experimental-vm-modules', fileURLToPath(new URL('./fixtures/chat-surface-startup.mjs', import.meta.url)), mode], { stdio: 'pipe' });
});
