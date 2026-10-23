// Start the FastAPI backend (Ring adapter) from its virtual environment.
//   npm run server
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const venvPython = process.platform === 'win32' ? join('.venv', 'Scripts', 'python.exe') : join('.venv', 'bin', 'python');
const python = existsSync(join('server', venvPython)) ? venvPython : 'python';
const port = process.env.THRESHOLD_PORT ?? '8787';
const child = spawn(python, ['-m', 'uvicorn', 'threshold_server.main:app', '--port', port, '--reload'], { cwd: 'server', stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
