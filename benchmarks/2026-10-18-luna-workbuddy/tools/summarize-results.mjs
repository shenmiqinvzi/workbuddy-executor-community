import { readdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const root = new URL('../', import.meta.url);
const ledger = new URL('ledger/', root);
const interim = process.argv.includes('--interim');
const files = (await readdir(ledger)).filter((name) => name.endsWith('.result.json')).sort();
const na = 'NA';
if (files.length !== 12) throw new Error(`Expected 12 per-run results, found ${files.length}`);
const frozenInputs = JSON.parse(await readFile(new URL('frozen-input-hashes.json', ledger), 'utf8'));
for (const entry of frozenInputs) {
  const bytes = await readFile(new URL(entry.path, root));
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== entry.sha256) throw new Error(`Frozen input hash mismatch: ${entry.path}`);
}
const checkerManifest = JSON.parse(await readFile(new URL('acceptance-harness-hash.json', ledger), 'utf8'));
const checkerBytes = await readFile(new URL('tools/verify.ps1', root));
const checkerSha = createHash('sha256').update(checkerBytes).digest('hex');
if (checkerSha !== checkerManifest.sha256) throw new Error('Frozen acceptance checker hash mismatch');
const get = (obj, ...keys) => {
  for (const key of keys) if (obj?.[key] !== undefined && obj[key] !== null) return obj[key];
  return na;
};
const csv = (value) => {
  const s = Array.isArray(value) ? value.join('; ') : value === undefined || value === null ? na : String(value);
  return `"${s.replaceAll('"', '""')}"`;
};
const boolCell = (value) => value === true ? 'true' : value === false ? 'false' : value ?? na;
const numeric = (value) => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim())) return Number(value);
  return null;
};

const rows = [];
for (const file of files) {
  const source = JSON.parse(await readFile(new URL(file, ledger), 'utf8'));
  const calls = Array.isArray(source.gatewayCalls) ? source.gatewayCalls : [];
  if (source.gatewayCallCount !== undefined && calls.length && calls.length !== Number(source.gatewayCallCount)) {
    throw new Error(`${file}: gatewayCallCount=${source.gatewayCallCount} but gatewayCalls.length=${calls.length}`);
  }
  const callBytes = calls.reduce((sum, call) => {
    const capturedOut = numeric(call.stdoutBytes) ?? numeric(call.combinedCliOutputBytes) ?? 0;
    const capturedErr = numeric(call.stderrBytes) ?? 0;
    return sum + capturedOut + capturedErr;
  }, 0);
  const explicitBytes = get(source, 'successfulGatewayStdoutBytes', 'successfulGatewayCliStdoutBytes');
  const combinedBytes = get(source, 'combinedCliOutputBytes');
  const cliBytes = Number.isFinite(Number(explicitBytes)) ? Number(explicitBytes) : combinedBytes !== na ? combinedBytes : calls.length ? callBytes : na;
  const failureCount = Number(get(source, 'failedGatewayInvocations', 'failedOrIncompleteGatewayInvocations', 'failedOrIncompleteInvocationCount') === na
    ? calls.filter((c) => c.exitCode !== undefined && Number(c.exitCode) !== 0).length
    : get(source, 'failedGatewayInvocations', 'failedOrIncompleteGatewayInvocations', 'failedOrIncompleteInvocationCount'));
  const successfulCount = get(source, 'successfulGatewayCallCount') !== na
    ? Number(source.successfulGatewayCallCount)
    : calls.some((c) => c.exitCode !== undefined)
      ? calls.filter((c) => Number(c.exitCode) === 0).length
      : Number(get(source, 'gatewayCallCount')) || na;
  const totalCount = successfulCount === na ? na : Number(successfulCount) + failureCount;
  const knownExitCalls = calls.filter((call) => Number.isInteger(Number(call.exitCode)) && call.exitCode !== undefined);
  if (calls.length && knownExitCalls.length === calls.length) {
    const exitSuccesses = knownExitCalls.filter((call) => Number(call.exitCode) === 0).length;
    const exitFailures = knownExitCalls.length - exitSuccesses;
    if (Number(successfulCount) !== exitSuccesses || failureCount !== exitFailures) {
      throw new Error(`${file}: recorded success/failure counts ${successfulCount}/${failureCount} disagree with per-call exit codes ${exitSuccesses}/${exitFailures}`);
    }
  }
  if (calls.length && cliBytes !== na && callBytes !== Number(cliBytes)) {
    throw new Error(`${file}: gateway response byte sum=${callBytes} but recorded CLI bytes=${cliBytes}`);
  }
  const startMs = Date.parse(source.startUTC);
  const endMs = Date.parse(source.endUTC);
  const seconds = numeric(source.totalSeconds);
  if (Number.isFinite(startMs) && Number.isFinite(endMs) && seconds !== null) {
    const measured = (endMs - startMs) / 1000;
    if (Math.abs(measured - seconds) > 0.01) {
      throw new Error(`${file}: start/end arithmetic=${measured}s but totalSeconds=${seconds}`);
    }
  }
  const comparable = source.strictPairTimeComparable ?? na;
  if (![true, false, na].includes(comparable)) throw new Error(`${file}: strictPairTimeComparable must be true/false/NA`);

  const fp = source.firstPass ?? {};
  const final = source.final ?? {};
  const firstOverall = get(fp, 'overallAcceptance') !== na
    ? fp.overallAcceptance
    : get(source, 'firstPassOverallAcceptance');
  const finalOverall = get(final, 'overallAcceptance') !== na
    ? final.overallAcceptance
    : get(source, 'finalOverallAcceptance', 'overallAcceptance');
  const inferredFinalOverall = finalOverall === na &&
    source.finalIndependentCheck?.checkerExitCode === 0 &&
    source.finalIndependentCheck?.protectedSourceHashMatches === true &&
    source.finalContentCheckPass === true && source.finalScopeCheckPass === true
      ? true : finalOverall;
  const resolvedFinalOverall = inferredFinalOverall;
  const direct = /direct/i.test(source.condition ?? '');
  const status = resolvedFinalOverall === true ? 'accepted' :
    resolvedFinalOverall === false ? (source.taskFinalState === 'cancelled' ? 'cancelled' : source.taskFinalState === 'blocked' ? 'blocked' : 'not accepted') :
    source.taskFinalState ?? 'incomplete';
  const rawRecoveryRounds = get(source, 'externalRecoveryRounds');
  const recoveryRounds = Array.isArray(rawRecoveryRounds) ? rawRecoveryRounds.length : rawRecoveryRounds;
  const row = {
    run: source.run,
    pair: source.pair,
    condition: source.condition,
    status,
    startUTC: get(source, 'startUTC'),
    endUTC: get(source, 'endUTC'),
    totalSeconds: get(source, 'totalSeconds'),
    timingBasis: get(source, 'timingQuality', 'endpointTimeBasis'),
    strictPairTimeComparable: get(source, 'strictPairTimeComparable'),
    firstContent: boolCell(get(fp, 'contentCheckPass') !== na ? fp.contentCheckPass : get(source, 'firstContentCheckPass')),
    firstScope: boolCell(get(fp, 'scopeCheckPass') !== na ? fp.scopeCheckPass : get(source, 'firstScopeCheckPass')),
    firstOverall: boolCell(firstOverall),
    finalContent: boolCell(get(final, 'contentCheckPass') !== na ? final.contentCheckPass : get(source, 'finalContentCheckPass', 'contentCheckPass')),
    finalScope: boolCell(get(final, 'scopeCheckPass') !== na ? final.scopeCheckPass : get(source, 'finalScopeCheckPass', 'scopeCheckPass')),
    finalOverall: boolCell(resolvedFinalOverall),
    reworkRounds: get(source, 'externalReworkRounds', 'reworkRounds', 'codexInitiatedReworkRounds'),
    recoveryRounds,
    userInterventionEpisodes: get(source, 'userInterventions'),
    successfulGatewayCalls: direct ? na : successfulCount,
    totalGatewayCalls: direct ? na : totalCount,
    nonzeroOrIncompleteGatewayCalls: direct ? na : failureCount,
    cliOutputFileBytes: direct ? na : cliBytes,
    cliCaptureKind: direct ? na : get(source, 'outputCaptureMode', 'cliCaptureKind') !== na
      ? get(source, 'outputCaptureMode', 'cliCaptureKind')
      : 'CLI stdout file-byte total; not MCP wire bytes',
    mcpWireBytes: get(source, 'mcpWireBytes'),
    tokens: get(source, 'tokenCounts', 'tokens'),
    activeReasoningSeconds: get(source, 'activeReasoningSeconds'),
    localLauncherPreflightErrors: get(source, 'localLauncherPreflightErrors'),
    notes: Array.isArray(source.notes) ? source.notes.join(' | ') : get(source, 'notes')
  };
  rows.push(row);
}

for (const pair of ['S1', 'S2', 'F1', 'F2', 'R1', 'R2']) {
  const pairRows = rows.filter((row) => row.pair === pair);
  if (pairRows.length !== 2) throw new Error(`${pair}: expected exactly two condition results`);
  const [direct, workbuddy] = pairRows.sort((a, b) => a.run.localeCompare(b.run));
  if (direct.strictPairTimeComparable !== workbuddy.strictPairTimeComparable) {
    throw new Error(`${pair}: strictPairTimeComparable differs within pair`);
  }
}

const columns = Object.keys(rows[0] ?? {});
const csvText = [columns.map(csv).join(','), ...rows.map((row) => columns.map((key) => csv(row[key])).join(','))].join('\r\n') + '\r\n';
await writeFile(interim ? new URL('interim-summary.csv', ledger) : new URL('results.csv', root), csvText, 'utf8');
await writeFile(interim ? new URL('interim-results.json', ledger) : new URL('results.json', root), JSON.stringify({
  generatedUTC: new Date().toISOString(),
  sourceFiles: files.map((name) => `ledger/${name}`),
  results: rows
}, null, 2) + '\n', 'utf8');
console.log(`Validated ${frozenInputs.length} frozen input hashes and checker ${checkerSha}; generated ${rows.length} result rows from ${files.length} per-run JSON files (${interim ? 'interim snapshot' : 'final summary'}).`);
