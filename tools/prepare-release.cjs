// Build a reviewable VSIX; never reads credentials or uploads to Marketplace.
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
process.chdir(path.resolve(__dirname, '..'));
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
const ref = process.env.GITHUB_REF || process.env.BUILD_SOURCEBRANCH || '';
if (ref.startsWith('refs/tags/') && ref !== `refs/tags/v${pkg.version}`) {
  throw new Error(`Release tag ${ref} does not match package version ${pkg.version}`);
}
function run(args) {
  const executable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = spawnSync(executable, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
run(['run', 'check']);
const output = `${pkg.name}-${pkg.version}.vsix`;
run(['exec', '--yes', '--package=@vscode/vsce@4.0.0', '--', 'vsce', 'package', '--no-dependencies', '--out', output]);
const sha = crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex');
fs.writeFileSync(output + '.sha256', `${sha}  ${output}\n`);
console.log(`Prepared ${output}. Not uploaded. Upload using Update on:`);
console.log(`https://marketplace.visualstudio.com/manage/publishers/${pkg.publisher}`);
