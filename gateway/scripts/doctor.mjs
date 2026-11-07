#!/usr/bin/env node
const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error('Node.js >=22.13.0 is required.'); process.exit(1);
}
// A load failure and a rejected option are different problems and get different advice: an unknown
// option must report the real usage, a missing build must name the build, and a missing package must
// name the package instead of blaming npm ci for all three.
const missingPackage = error => {
  const text = error && typeof error.message === 'string' ? error.message : '';
  const match = /Cannot find package '([^']+)'/.exec(text);
  return match ? match[1] : null;
};
try {
  const { runDoctor } = await import('../dist/doctor.js');
  const code = await runDoctor(process.argv.slice(2));
  if (typeof code === 'number') process.exitCode = code;
} catch (error) {
  const code = error && error.code;
  const pkg = missingPackage(error);
  if (pkg) {
    console.error(`Gateway dependency '${pkg}' is missing. Run node scripts/bootstrap.mjs --install-root . (or npm ci --omit=dev) in the gateway directory, then retry.`);
  } else if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_UNSUPPORTED_DIR_IMPORT') {
    console.error('The gateway build is missing (dist/doctor.js). Run npm run build after installing dependencies, then retry.');
  } else if (error && typeof error.message === 'string' && error.message.length) {
    console.error(`Diagnosis could not run: ${error.name || 'Error'}. Check the gateway build and local configuration; diagnosis never prints credentials.`);
  } else {
    console.error('Diagnosis could not run. Check the gateway build and local configuration; diagnosis never prints credentials.');
  }
  process.exitCode = 1;
}
