/** Read-only replacement for the obsolete plaintext phonebook PSK check.
 * Compiles the native credential structure and probes the pipe; no RAS API call,
 * VPN entry, saved credential or real phonebook is read or changed.
 */
import { RasCredentials, RAS_NATIVE_SOURCE } from '../src/main/system/vpn/RasCredentials';

async function main() {
  const script = `$ErrorActionPreference='Stop';[Console]::InputEncoding=[Text.Encoding]::UTF8;$data=[Console]::In.ReadToEnd()|ConvertFrom-Json;Add-Type -TypeDefinition @'\n${RAS_NATIVE_SOURCE}\n'@\n@{ok=($data.password -ceq $data.psk);code=[Runtime.InteropServices.Marshal]::SizeOf([type][BlueWingRasCredentials+Credentials])}|ConvertTo-Json -Compress`;
  const result = await RasCredentials.run(script, {password:'fixture-测试',psk:'fixture-测试'});
  if (!result.ok || result.code !== 1068) throw new Error('RAS credential pipe/ABI check failed');
  console.log('PASS: Unicode pipe and RASCREDENTIALSW layout; no phonebook or credentials changed.');
}
main().catch(error => { console.error(error.message); process.exitCode=1; });
