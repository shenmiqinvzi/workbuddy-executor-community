import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Only newly created bridge paths may be protected. Existing user ACLs are
// inspected, never repaired. No shell interpolation or path arguments.
const script = String.raw`
$ErrorActionPreference='Stop'
$parts=[Console]::In.ReadToEnd().Split([char]10)
if ($parts.Length -ne 3) { throw 'input' }
$target=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[0]))
$protect=$parts[1] -eq '1'
$directory=$parts[2] -eq '1'
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ($protect) {
  $acl=if ($directory) { [IO.Directory]::GetAccessControl($target) } else { [IO.File]::GetAccessControl($target) }
  $acl.SetAccessRuleProtection($true,$false)
  if ($directory) { $rule=[Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
  else { $rule=[Security.AccessControl.FileSystemAccessRule]::new($me,'FullControl','Allow') }
  $acl.AddAccessRule($rule)
  if ($directory) { [IO.Directory]::SetAccessControl($target,$acl) }
  else { [IO.File]::SetAccessControl($target,$acl) }
}
if ([IO.File]::GetAttributes($target) -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
$acl=if ($directory) { [IO.Directory]::GetAccessControl($target) } else { [IO.File]::GetAccessControl($target) }
if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($me.Value,'S-1-5-32-544')) { throw 'owner' }
$allowed=@($me.Value,'S-1-5-18','S-1-5-32-544')
foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) { throw 'shared' }
}
[Console]::Out.Write('private')
`;
export function windowsPrivatePath(path, { protect = false, directory = false } = {}) {
  if (process.platform !== 'win32') return;
  try {
    const result = execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { input: `${Buffer.from(path, 'utf8').toString('base64')}\n${protect ? 1 : 0}\n${directory ? 1 : 0}`, encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.trim() !== 'private') throw Error();
  } catch (error) {
    const reason = error?.code === 'ETIMEDOUT' ? 'query_timeout' : 'query_failed';
    throw Object.assign(new Error(`bridge/insecure-path: ${reason}`), { code: 'bridge/insecure-path', reason });
  }
}
