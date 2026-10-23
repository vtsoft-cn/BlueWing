import { spawn } from 'child_process';
import fs from 'fs';
import { VpnCoreProcess, childEnvironment } from '../vpn/VpnCoreProcess';
export interface WinInetConnection {
  name: string;
  flags: number;
  server: string;
  bypass: string;
  pac: string;
}
export class WinInetProxy {
  static available(): boolean {
    return (
      process.platform === 'win32' && fs.existsSync(VpnCoreProcess.locate())
    );
  }
  static run(request: {
    action: 'query' | 'enable' | 'disable' | 'restore';
    server?: string;
    bypass?: string;
    managedServer?: string;
    connections?: WinInetConnection[];
  }): Promise<WinInetConnection[]> {
    VpnCoreProcess.verifyBinary(VpnCoreProcess.locate());
    return new Promise((resolve, reject) => {
      const p = spawn(VpnCoreProcess.locate(), ['--system-proxy'], {
        windowsHide: true,
        env: childEnvironment(process.env),
      });
      let data = '';
      const timer = setTimeout(() => {
        p.kill();
        reject(new Error('WinINet helper timeout'));
      }, 10000);
      p.stdout.on('data', (b) => {
        data += b;
        if (data.length > 1024 * 1024) p.kill();
      });
      p.stderr.resume();
      p.on('error', () => {
        clearTimeout(timer);
        reject(new Error('WinINet helper failed'));
      });
      p.on('close', () => {
        clearTimeout(timer);
        try {
          const result = JSON.parse(data);
          if (!result.ok) throw new Error('WinINet connection update failed');
          resolve(result.connections || []);
        } catch (e) {
          reject(e);
        }
      });
      p.stdin.end(JSON.stringify(request));
    });
  }
}
