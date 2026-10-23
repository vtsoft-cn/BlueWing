import { spawn } from 'child_process';
/** Read only: choose a default-route hardware adapter, never a TUN/VMware/Hyper-V interface. */
export function physicalInterface(): Promise<string> {
  if (process.platform !== 'win32')
    return Promise.reject(new Error('UNDERLAY_INTERFACE_REQUIRED'));
  const script = `$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)
$physical=@(Get-NetAdapter -Physical | Where-Object Status -eq Up)
$routes=@(Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Where-Object { $physical.ifIndex -contains $_.InterfaceIndex } | Sort-Object @{Expression={$_.RouteMetric + $_.InterfaceMetric}})
if($routes.Count -eq 0){throw 'No physical default route'}
$adapter=$physical | Where-Object ifIndex -eq $routes[0].InterfaceIndex | Select-Object -First 1
$adapter.Name | ConvertTo-Json -Compress`;
  return new Promise((resolve, reject) => {
    const p = spawn(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { windowsHide: true },
    );
    let output = '';
    const timer = setTimeout(() => {
      p.kill();
      reject(new Error('UNDERLAY_INTERFACE_REQUIRED：请选择物理网卡'));
    }, 8000);
    p.stdout.on('data', (b) => {
      output += b;
      if (output.length > 4096) p.kill();
    });
    p.stderr.resume();
    p.on('error', () => {
      clearTimeout(timer);
      reject(new Error('UNDERLAY_INTERFACE_REQUIRED'));
    });
    p.on('close', () => {
      clearTimeout(timer);
      try {
        const name = JSON.parse(output.replace(/^\uFEFF/, ''));
        if (typeof name !== 'string' || !name || name.length > 200)
          throw new Error();
        resolve(name);
      } catch {
        reject(
          new Error(
            'UNDERLAY_INTERFACE_REQUIRED：请在接入配置中指定物理网卡名称',
          ),
        );
      }
    });
  });
}
