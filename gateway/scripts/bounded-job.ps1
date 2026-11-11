param([Parameter(Mandatory=$true)][string]$SpecFile,[string]$StartedFile,[string]$ReadyFile)
$ErrorActionPreference = 'Stop'
# Phase marker: written before the C# helper exists, so a parent can tell "the supervisor never
# started" apart from "the supervisor is still compiling" without guessing from elapsed time.
if(![string]::IsNullOrEmpty($ReadyFile)) {
  [IO.File]::WriteAllText($ReadyFile,'{"pid":' + $PID + ',"phase":"helper_ready","at":"' + [DateTime]::UtcNow.ToString('o') + '"}',(New-Object Text.UTF8Encoding($false)))
}
$spec = Get-Content -LiteralPath $SpecFile -Raw -Encoding UTF8 | ConvertFrom-Json
$source = @'
using System;
using System.Text;
using System.IO;
using System.Threading;
using System.Runtime.InteropServices;
public static class BoundedJob {
  [StructLayout(LayoutKind.Sequential)] struct SA { public int length; public IntPtr descriptor; public int inherit; }
  [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct SI { public int cb; public string reserved,desktop,title; public int x,y,xs,ys,xc,yc,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
  [StructLayout(LayoutKind.Sequential)] struct PI { public IntPtr process,thread; public int pid,tid; }
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long perProcess,perJob; public uint flags; public UIntPtr min,max; public uint active; public UIntPtr affinity; public uint priority,scheduling; }
  [StructLayout(LayoutKind.Sequential)] struct IO { public ulong readOps,writeOps,otherOps,readBytes,writeBytes,otherBytes; }
  [StructLayout(LayoutKind.Sequential)] struct LIMIT { public BASIC basic; public IO io; public UIntPtr processMemory,jobMemory,peakProcess,peakJob; }
  [StructLayout(LayoutKind.Sequential)] struct ACCOUNT { public long user,kernel,periodUser,periodKernel; public uint faults,total,active,terminated; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes,string name);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int kind,ref LIMIT info,int size);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int kind,ref ACCOUNT info,int size,IntPtr returned);
  [DllImport("kernel32.dll",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref SI si,out PI pi);
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateFile(string file,uint access,uint share,ref SA sa,uint creation,uint flags,IntPtr template);
  [DllImport("kernel32.dll")] static extern uint ResumeThread(IntPtr thread);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle,uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr process,out uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateJobObject(IntPtr job,uint code);
  [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process,uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if(!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) { return "\"" + System.Text.RegularExpressions.Regex.Replace(value, "(\\\\*)\"", "$1$1\\\"") + new string('\\', Trailing(value)) + "\""; }
  static int Trailing(string s) { int n=0; for(int i=s.Length-1;i>=0&&s[i]=='\\';i--)n++; return n; }
  public static string Run(string exe,string[] args,string cwd,string stdout,string stderr,int timeout,string cancel,string startedFile) {
    IntPtr job=IntPtr.Zero,output=IntPtr.Zero,error=IntPtr.Zero,input=IntPtr.Zero; PI pi=new PI(); bool assigned=false;
    string reason="exit"; uint exit=1; int active=0;
    try {
      if(!String.IsNullOrEmpty(cancel)&&File.Exists(cancel))return "{\"exitCode\":130,\"reason\":\"cancelled\",\"cleanupConfirmed\":true,\"ownership\":\"not_started\"}";
      job=CreateJobObject(IntPtr.Zero,null);Check(job!=IntPtr.Zero);
      LIMIT limit=new LIMIT();limit.basic.flags=0x2000;Check(SetInformationJobObject(job,9,ref limit,Marshal.SizeOf(limit)));
      SA sa=new SA();sa.length=Marshal.SizeOf(sa);sa.inherit=1;
      output=CreateFile(stdout,0x40000000,3,ref sa,2,0,IntPtr.Zero);Check(output!=new IntPtr(-1));
      error=CreateFile(stderr,0x40000000,3,ref sa,2,0,IntPtr.Zero);Check(error!=new IntPtr(-1));
      input=CreateFile("NUL",0x80000000,3,ref sa,3,0,IntPtr.Zero);Check(input!=new IntPtr(-1));
      SI si=new SI();si.cb=Marshal.SizeOf(si);si.flags=0x100;si.input=input;si.output=output;si.error=error;
      StringBuilder command=new StringBuilder(Quote(exe));foreach(string arg in args)command.Append(" ").Append(Quote(arg));
      Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,true,0x08000004,IntPtr.Zero,cwd,ref si,out pi));
      // Durable proof that this command really started: a supervisor that never ran leaves no marker,
      // so a blocked script cannot be mistaken for a process tree that still needs cleaning. The
      // timestamp lets the parent measure the command's own deadline from the real target start.
      if(!String.IsNullOrEmpty(startedFile))File.WriteAllText(startedFile,"{\"pid\":"+pi.pid+",\"startedAt\":\""+DateTime.UtcNow.ToString("o")+"\"}",new UTF8Encoding(false));
      // Suspended creation prevents a child escaping before ownership is established.
      Check(AssignProcessToJobObject(job,pi.process));assigned=true;Check(ResumeThread(pi.thread)!=0xffffffff);
      var watch=System.Diagnostics.Stopwatch.StartNew();
      while(WaitForSingleObject(pi.process,100)==258) {
        if(!String.IsNullOrEmpty(cancel)&&File.Exists(cancel)){reason="cancelled";break;}
        if(watch.ElapsedMilliseconds>=timeout){reason="timeout";break;}
      }
      if(reason!="exit")Check(TerminateJobObject(job,reason=="timeout"?124u:130u));
      WaitForSingleObject(pi.process,3000);Check(GetExitCodeProcess(pi.process,out exit));
      // Even a normally exited command must not leave detached browser/test descendants.
      Check(TerminateJobObject(job,exit));
      ACCOUNT account=new ACCOUNT();
      for(int i=0;i<30;i++){Check(QueryInformationJobObject(job,1,ref account,Marshal.SizeOf(account),IntPtr.Zero));active=(int)account.active;if(active==0)break;Thread.Sleep(100);}
      return "{\"pid\":"+pi.pid+",\"exitCode\":"+exit+",\"reason\":\""+reason+"\",\"cleanupConfirmed\":"+(active==0?"true":"false")+",\"ownership\":\"windows_job_object\"}";
    } finally {
      if(pi.process!=IntPtr.Zero&&!assigned)TerminateProcess(pi.process,125);
      if(job!=IntPtr.Zero)CloseHandle(job);
      foreach(IntPtr h in new[]{pi.thread,pi.process,output,error,input})if(h!=IntPtr.Zero&&h!=new IntPtr(-1))CloseHandle(h);
    }
  }
}
'@
# Compiling this helper with Add-Type costs about 1.3s per supervised command, and the CodeDom
# compiler is the elastic part of supervisor startup: when many commands start at once (the full
# test suite starts dozens) the compile queue pushed startup past the parent watchdog. The compiled
# assembly is therefore cached by source hash and only compiled when the cache misses. A cache hit
# keeps the supervisor's startup bounded and independent of how many commands run in parallel.
$loaded = $false
try {
  $sha = [Security.Cryptography.SHA256]::Create()
  $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-','').ToLowerInvariant()
  $cacheRoot = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'WorkBuddy\bounded-job'
  New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
  $assembly = Join-Path $cacheRoot ($digest.Substring(0,32) + '.dll')
  if (Test-Path -LiteralPath $assembly) {
    try { [void][Reflection.Assembly]::LoadFile($assembly); $loaded = $true } catch { $loaded = $false }
  }
  if (!$loaded) {
    $temp = Join-Path $cacheRoot ($digest.Substring(0,32) + '.' + $PID + '.tmp')
    try {
      Add-Type -TypeDefinition $source -OutputAssembly $temp -ErrorAction Stop
      Move-Item -LiteralPath $temp -Destination $assembly -Force -ErrorAction Stop
      [void][Reflection.Assembly]::LoadFile($assembly); $loaded = $true
    } catch {
      if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force -ErrorAction SilentlyContinue }
    }
  }
} catch { $loaded = $false }
if (!$loaded) { Add-Type -TypeDefinition $source }
[BoundedJob]::Run([string]$spec.executable,[string[]]$spec.args,[string]$spec.cwd,[string]$spec.stdout,[string]$spec.stderr,[int]$spec.timeoutMs,[string]$spec.cancelFile,[string]$StartedFile)
