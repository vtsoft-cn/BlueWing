import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

export function privateDirectory(dir: string): void {
  if (path.resolve(dir) === path.parse(path.resolve(dir)).root) throw new Error('不能将盘符根目录作为凭据目录');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    // Replace the DACL: /grant:r alone leaves pre-existing explicit grants to
    // other accounts intact. Pass the path as data, never PowerShell source.
    const encodedPath = Buffer.from(path.resolve(dir), 'utf16le').toString('base64');
    // Change the DACL only. Replacing the owner requires privileges a normal
    // desktop process may not have, even when it can read/write the directory.
    const script = `$ErrorActionPreference='Stop'; $target=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedPath}')); $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User; $acl=[IO.Directory]::GetAccessControl($target,[Security.AccessControl.AccessControlSections]::Access); $acl.SetAccessRuleProtection($true,$false); foreach($existing in @($acl.Access)){$null=$acl.RemoveAccessRuleSpecific($existing)}; $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow'); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($target,$acl)`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore', windowsHide: true });
  } else {
    fs.chmodSync(dir, 0o700);
  }
}
