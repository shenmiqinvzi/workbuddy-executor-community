import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

// Only newly created bridge paths may be protected. Existing user ACLs are
// inspected, never repaired. No shell interpolation or path arguments.
const script = String.raw`
$ErrorActionPreference='Stop'
$data=[Console]::In.ReadToEnd() | ConvertFrom-Json
$me=[Security.Principal.WindowsIdentity]::GetCurrent().User
if ($data.protect) {
  $acl=if ($data.directory) { [IO.Directory]::GetAccessControl($data.path) } else { [IO.File]::GetAccessControl($data.path) }
  $acl.SetAccessRuleProtection($true,$false)
  if ($data.directory) { $rule=New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','ContainerInherit,ObjectInherit','None','Allow') }
  else { $rule=New-Object Security.AccessControl.FileSystemAccessRule($me,'FullControl','Allow') }
  $acl.AddAccessRule($rule)
  if ($data.directory) { [IO.Directory]::SetAccessControl($data.path,$acl) }
  else { [IO.File]::SetAccessControl($data.path,$acl) }
}
if ([IO.File]::GetAttributes($data.path) -band [IO.FileAttributes]::ReparsePoint) { throw 'reparse' }
$acl=if ($data.directory) { [IO.Directory]::GetAccessControl($data.path) } else { [IO.File]::GetAccessControl($data.path) }
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
      { input: JSON.stringify({ path, protect, directory }), encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 65536, stdio: ['pipe', 'pipe', 'pipe'] });
    if (result.trim() !== 'private') throw Error();
  } catch { throw new Error('bridge/insecure-path'); }
}
