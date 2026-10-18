param(
  [Parameter(Mandatory=$true)][ValidateSet('S1','S2','F1','F2','R1','R2')][string]$Task,
  [Parameter(Mandatory=$true)][string]$Workspace
)
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path $Workspace).Path
Push-Location $root
try {
  switch ($Task) {
    'S1' {
      $doc = Get-Content -Raw PACKAGE.md
      $steps = [regex]::Matches($doc, '(?m)^\d+\.\s+.+$')
      $allSteps = [regex]::Matches($doc, '(?m)^\s*(?:\d+\.|[-*])\s+.+$')
      $links = [regex]::Matches($doc, '\[[^\]]+\]\(([^)]+)\)')
      $mustKeep = @('Download the package.', 'Run `node src/hello.js`.', 'Read the source at [hello]')
      foreach ($text in $mustKeep) { if (-not $doc.Contains($text)) { throw "S1 original instruction missing: $text" } }
      if ($steps.Count -ne 3 -or $allSteps.Count -ne 3 -or $links.Count -ne 1 -or $links[0].Groups[1].Value -cne 'src/hello.js' -or -not (Test-Path 'src/hello.js')) { throw 'S1 requires exactly three ordered numbered instructions and one resolving src/hello.js link' }
      'PASS: exactly three numbered steps, original instruction content retained, required link resolves'
    }
    'S2' {
      $rows = @(Import-Csv inventory.csv)
      $headers = (Get-Content inventory.csv -TotalCount 1)
      if ($headers -cne 'item_id,item_name,quantity' -or $rows.Count -ne 3) { throw 'S2 header or row count mismatch' }
      $actual = @($rows | ForEach-Object { "$($_.item_id),$($_.item_name),$($_.quantity)" })
      $expected = @('101,Pencil,20','102,Eraser,5','103,Notebook,8')
      if (($actual -join '|') -cne ($expected -join '|')) { throw 'S2 ordered rows or original item-name/quantity pairs mismatch' }
      'PASS: normalized header, exact ordered rows and preserved item data'
    }
    'F1' {
      $out = Join-Path ([IO.Path]::GetTempPath()) ('study-f1-' + [guid]::NewGuid().ToString('N'))
      New-Item -ItemType Directory -Path $out | Out-Null
      $harness = Join-Path $out 'Contract.java'
      @'
public final class Contract {
    private static void eq(double actual, double expected, String label) {
        if (Double.isNaN(actual) || Math.abs(actual - expected) > 1e-9) throw new AssertionError(label + ": " + actual);
    }
    public static void main(String[] args) {
        eq(Discount.apply(100, .2), 80, "normal rate");
        eq(Discount.apply(100, -1), 100, "negative rate clamps to zero");
        eq(Discount.apply(100, 2), 0, "rate above one clamps to one");
        eq(Discount.apply(100, Double.NaN), 100, "NaN rate preserves price");
        eq(Discount.apply(-5, .5), 0, "negative result clamps to zero");
    }
}
'@ | Set-Content -LiteralPath $harness -Encoding ascii
      try {
        & javac -d $out (Join-Path $root 'src/Discount.java') (Join-Path $root 'test/DiscountTest.java')
        if ($LASTEXITCODE -ne 0) { throw 'javac worker F1 tests failed' }
        & java -cp $out DiscountTest
        if ($LASTEXITCODE -ne 0) { throw 'worker F1 tests failed' }
        Remove-Item -LiteralPath (Join-Path $out 'Discount.class') -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $out 'DiscountTest.class') -Force -ErrorAction SilentlyContinue
        & javac -d $out (Join-Path $root 'src/Discount.java') $harness
        if ($LASTEXITCODE -ne 0) { throw 'javac independent F1 contract harness failed' }
        & java -cp $out Contract
        if ($LASTEXITCODE -ne 0) { throw 'independent F1 contract failed' }
        'PASS: independent frozen five-case Java contract harness'
      } finally {
        $resolved = [IO.Path]::GetFullPath($out)
        $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
        if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Refusing cleanup outside temp root: $resolved" }
        Remove-Item -LiteralPath $resolved -Recurse -Force
      }
    }
    'F2' {
      $contract = @'
const assert = require('node:assert/strict');
const { rank } = require('./src/rank');
const input = [{id:'a',score:2},{id:'b',score:5},{id:'c',score:2},{id:'d'},{id:'e',score:1}];
const before = structuredClone(input);
const result = rank(input);
assert.notStrictEqual(result, input, 'must return a new array');
assert.deepEqual(result.map(x=>x.id), ['b','a','c','e','d']);
assert.deepEqual(input, before, 'must not mutate input order or contents');
'@
      & node --test test/rank.test.js
      if ($LASTEXITCODE -ne 0) { throw 'worker F2 tests failed' }
      & node -e $contract
      if ($LASTEXITCODE -ne 0) { throw 'independent F2 contract failed' }
      'PASS: independent Node contract covers descending, stability, missing score, new array and input preservation'
    }
    'R1' {
      $doc = Get-Content -Raw RELEASE-NOTE.md
      $bullets = [regex]::Matches($doc, '(?m)^\s*[-*]\s+(.+)$')
      if ($bullets.Count -lt 3 -or $bullets.Count -gt 5) { throw 'R1 requires 3-5 bullets' }
      $required = @('api.md','ui.md','ops.md')
      foreach ($bullet in $bullets) {
        $hasCitation = $false
        foreach ($name in $required) { if ($bullet.Groups[1].Value.Contains($name)) { $hasCitation = $true } }
        if (-not $hasCitation) { throw 'R1 each bullet must cite an exact source filename; inspect claim support and release uncertainty manually' }
      }
      'PASS: 3-5 bullets; each cites an exact source filename. Claim support, all three areas and uncertainty require manual review.'
    }
    'R2' {
      $doc = Get-Content -Raw TEST-GAPS.md
      $bullets = [regex]::Matches($doc, '(?m)^\s*(?:[-*]|\d+[.)])\s+(.+)$')
      if ($bullets.Count -ne 3) { throw 'R2 requires exactly three bullets' }
      foreach ($m in $bullets) {
        $line = $m.Groups[1].Value
        $citation = [regex]::Match($line, '(src|test)/[^\s,:;()]+\.js\s*:\s*(\d+)')
        if (-not $citation.Success) { throw 'R2 bullet must cite an exact source/test path:line' }
        $path = $citation.Value -replace '\s+', '' -replace ':\d+$', ''
        $ln = [int]$citation.Groups[2].Value
        if (-not (Test-Path -LiteralPath $path)) { throw "R2 cited path missing: $path" }
        $sourceLines = @(Get-Content -LiteralPath $path)
        if ($ln -lt 1 -or $ln -gt $sourceLines.Count) { throw "R2 cited line missing: ${path}:$ln" }
      }
      'PASS: exactly three bullets with an existing source/test path:line in each; distinct behavior and semantic support require manual review'
    }
  }
} finally { Pop-Location }
