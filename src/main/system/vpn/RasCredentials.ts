import { spawn } from 'child_process';
import path from 'path';

// RASCREDENTIALSW: UNLEN=256, PWLEN=256, DNLEN=15. Do not combine
// RASCM_PreSharedKey with the username/password masks.
export const RAS_NATIVE_SOURCE = String.raw`
using System;
using System.Runtime.InteropServices;
public static class BlueWingRasCredentials {
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct Credentials {
    public uint size, mask;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=257)] public string user;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=257)] public string password;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=16)] public string domain;
  }
  [DllImport("rasapi32.dll", EntryPoint="RasSetCredentialsW", CharSet=CharSet.Unicode, ExactSpelling=true)]
  [DefaultDllImportSearchPaths(DllImportSearchPath.System32)]
  private static extern uint SetCredentials(string book, string entry, ref Credentials credentials, bool clear);
  public static uint Store(string entry, uint mask, string user, string password, bool clear) {
    var c=new Credentials {size=(uint)Marshal.SizeOf(typeof(Credentials)),mask=mask,user=user,password=password,domain=""};
    try { return SetCredentials(null,entry,ref c,clear); }
    finally { c.user=null; c.password=null; c.domain=null; }
  }
}`;
const preamble = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.Encoding]::UTF8; $data=[Console]::In.ReadToEnd() | ConvertFrom-Json; Add-Type -TypeDefinition @'\n${RAS_NATIVE_SOURCE}\n'@\n`;
export const RAS_SETUP_SCRIPT = preamble + String.raw`
try {
  Remove-VpnConnection -Name $data.entry -Force -ErrorAction SilentlyContinue
  $parameters=@{Name=$data.entry;ServerAddress=$data.server;TunnelType=$data.tunnel;SplitTunneling=[bool]$data.split;Force=$true;ErrorAction='Stop'}
  if ($data.suffix) { $parameters.DnsSuffix=$data.suffix }
  if ($data.psk) { $parameters.L2tpPsk=$data.psk }
  $null=Add-VpnConnection @parameters
  if ($data.psk) {
    $code=[BlueWingRasCredentials]::Store($data.entry,16,'',$data.psk,$false)
    if ($code -ne 0) { @{ok=$false;code=$code} | ConvertTo-Json -Compress; exit 1 }
  }
  if ($data.user) {
    $code=[BlueWingRasCredentials]::Store($data.entry,3,$data.user,$data.password,$false)
    if ($code -ne 0) { @{ok=$false;code=$code} | ConvertTo-Json -Compress; exit 1 }
  }
  @{ok=$true} | ConvertTo-Json -Compress
} catch { @{ok=$false} | ConvertTo-Json -Compress; exit 1 }
finally { $data=$null }
`;
export const RAS_CLEAR_SCRIPT = preamble + String.raw`
try {
  $null=[BlueWingRasCredentials]::Store($data.entry,3,'','',$true)
  $null=[BlueWingRasCredentials]::Store($data.entry,16,'','',$true)
  Remove-VpnConnection -Name $data.entry -Force -ErrorAction SilentlyContinue
  @{ok=$true} | ConvertTo-Json -Compress
} catch { @{ok=$false} | ConvertTo-Json -Compress }
`;

export class RasCredentials {
  static async run(script: string, data: Record<string, unknown>, timeoutMs = 15000): Promise<{ok:boolean;code?:number}> {
    for (const [key,max] of [['user',256],['password',256],['psk',256]] as const) {
      const value=data[key];
      if (value !== undefined && (typeof value !== 'string' || value.length > max || value.includes('\0'))) throw new Error('RAS 凭据格式或长度不正确');
    }
    return new Promise(resolve => {
      let done=false, output='';
      const finish=(value:{ok:boolean;code?:number})=>{if(!done){done=true;clearTimeout(timer);resolve(value);}};
      const child=spawn(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-NonInteractive','-Command',script],{
        windowsHide:true,stdio:['pipe','pipe','pipe'],
        env:{...process.env,PSModulePath:path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','Modules')},
      });
      const timer=setTimeout(()=>{child.kill();finish({ok:false});},timeoutMs);
      child.stdout.on('data',chunk=>{output+=chunk.toString();if(output.length>16384){child.kill();finish({ok:false});}});
      // Never surface PowerShell error records: cmdlets can include input values.
      child.stderr.resume();
      child.on('error',()=>finish({ok:false}));
      child.stdin.on('error',()=>{child.kill();finish({ok:false});});
      child.on('close',code=>{
        try { const value=JSON.parse(output.trim());finish({ok:code===0 && value.ok===true,code:Number.isInteger(value.code)?value.code:undefined}); }
        catch { finish({ok:false}); }
      });
      // Values travel only through the private pipe, never script text, argv or files.
      child.stdin.end(JSON.stringify(data));
    });
  }
}
