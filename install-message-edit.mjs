// Manual fallback installer: install dshx-message-edit from this checkout into a DSH profile.
// Prefer `dsh plugin --profile <profile> add github:<owner>/dshx-message-edit`.
//
//   node install-message-edit.mjs [profile]   (default profile: desktop; honours DSH_HOME)
//
// It performs the three registration points MAINTENANCE.md requires, all of
// which must be present or the plugin "installs but never activates":
//
//   1. copy the source into <profile>/node_modules/<name>/  (file: deps are a
//      COPY in pnpm, not a symlink);
//   2. package.json -> dependencies (file: absolute path) + dsh.profile.bundles;
//   3. cordis.patch.yml -> an explicit `- id` + `name` row, because a plugin's
//      own `- insert:` block does not reliably mount it.
//
// Safety:
//   - every touched file is backed up with a .bak-install-message-edit suffix;
//   - package.json is checked for a leading UTF-8 BOM after writing (the Edit
//     tool writes one; Node's JSON.parse rejects it, and it is a known suspect
//     for mount failures);
//   - cordis.patch.yml is re-parsed with the profile's own js-yaml so the edit
//     is verified structurally, not by regex;
//   - both files are written only after every transformation is computed.

import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

const PLUGIN_NAME = 'dshx-message-edit'
const SOURCE = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'profiles', process.argv[2] ?? 'desktop')
const TARGET = path.join(PROFILE, 'node_modules', PLUGIN_NAME)

const PKG_JSON = path.join(PROFILE, 'package.json')
const PATCH_YML = path.join(PROFILE, 'cordis.patch.yml')
const BACKUP_SUFFIX = '.bak-install-message-edit'

/** Files that make up the plugin; nothing else is copied. */
const PAYLOAD = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md']

/** Log one step. */
const step = (message) => console.log('  ' + message)

/** Fail loudly with a precise reason. */
const fail = (message) => {
  console.error('\nERROR: ' + message)
  process.exit(1)
}

/** Read a file's first bytes to detect a UTF-8 BOM. */
const hasBom = (buffer) => buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf

/** Strip a leading BOM in place if present; returns whether it did. */
const stripBom = async (file) => {
  const buffer = await fs.readFile(file)
  if (!hasBom(buffer)) return false
  await fs.writeFile(file, buffer.subarray(3))
  return true
}

console.log('\nInstalling ' + PLUGIN_NAME)
console.log('  source:  ' + SOURCE)
console.log('  profile: ' + PROFILE)

// --- preconditions ---------------------------------------------------------

for (const file of [PKG_JSON, PATCH_YML]) {
  try {
    await fs.access(file)
  } catch {
    fail('missing ' + file + ' — is the desktop profile installed?')
  }
}
try {
  await fs.access(path.join(SOURCE, 'index.js'))
} catch {
  fail('missing plugin source at ' + SOURCE)
}

// --- 1. copy the package into node_modules --------------------------------

step('1/3 copying the package into node_modules ...')
await fs.mkdir(TARGET, { recursive: true })
for (const name of PAYLOAD) {
  const from = path.join(SOURCE, name)
  try {
    await fs.access(from)
  } catch {
    continue // an optional file such as README.md
  }
  await fs.copyFile(from, path.join(TARGET, name))
}
const copied = await fs.readdir(TARGET)
step('    copied: ' + copied.join(', '))

// --- 2. package.json -------------------------------------------------------

step('2/3 updating package.json ...')
const rawPkg = await fs.readFile(PKG_JSON, 'utf8')
let pkg
try {
  pkg = JSON.parse(rawPkg)
} catch (error) {
  fail('package.json is not valid JSON: ' + error.message)
}

const wanted = 'file:' + SOURCE.replace(/\\/g, '/')
pkg.dependencies = pkg.dependencies ?? {}
const depBefore = pkg.dependencies[PLUGIN_NAME]
pkg.dependencies[PLUGIN_NAME] = wanted

pkg.dsh = pkg.dsh ?? {}
pkg.dsh.profile = pkg.dsh.profile ?? {}
pkg.dsh.profile.bundles = pkg.dsh.profile.bundles ?? []
const hadBundle = pkg.dsh.profile.bundles.includes(PLUGIN_NAME)
if (!hadBundle) pkg.dsh.profile.bundles.push(PLUGIN_NAME)

step('    dependencies.' + PLUGIN_NAME + ': ' + (depBefore ?? '(new)') + ' -> ' + wanted)
step('    bundles entry: ' + (hadBundle ? 'already present' : 'added'))

await fs.copyFile(PKG_JSON, PKG_JSON + BACKUP_SUFFIX)
// JSON.stringify with 2-space indent keeps the file's existing style; a
// trailing newline matches what pnpm writes.
await fs.writeFile(PKG_JSON, JSON.stringify(pkg, null, 2) + '\n')

const bomStripped = await stripBom(PKG_JSON)
step('    BOM: ' + (bomStripped ? 'stripped (was present)' : 'none'))
const afterBytes = await fs.readFile(PKG_JSON)
if (hasBom(afterBytes)) fail('package.json still has a BOM after stripping')
// Prove it parses as Node sees it, not as we hope.
JSON.parse(await fs.readFile(PKG_JSON, 'utf8'))
step('    re-parsed OK')

// --- 3. cordis.patch.yml ---------------------------------------------------

step('3/3 updating cordis.patch.yml ...')
const yamlPath = path.join(PROFILE, 'node_modules', 'js-yaml')
let yaml
try {
  yaml = require(yamlPath)
} catch {
  try {
    yaml = require('js-yaml')
  } catch {
    yaml = null
  }
}

const rawYaml = await fs.readFile(PATCH_YML, 'utf8')

// Parse with the profile's own js-yaml when available, so the edit is verified
// against the same parser the loader uses.
const rows = yaml === null ? null : yaml.load(rawYaml)
if (rows !== null && !Array.isArray(rows)) fail('cordis.patch.yml is not a top-level array')

const alreadyMounted = rows !== null
  && rows.some((row) => row !== null && typeof row === 'object' && row.id === PLUGIN_NAME)

if (alreadyMounted) {
  step('    mount row already present')
} else {
  await fs.copyFile(PATCH_YML, PATCH_YML + BACKUP_SUFFIX)
  const addition = '\n- id: ' + PLUGIN_NAME + '\n  name: ' + PLUGIN_NAME + '\n'
  await fs.appendFile(PATCH_YML, addition)
  step('    appended mount row')
  const bomInYaml = await stripBom(PATCH_YML)
  if (bomInYaml) step('    BOM: stripped')
}

// Verify structurally when a parser is available.
if (yaml !== null) {
  const verifyRows = yaml.load(await fs.readFile(PATCH_YML, 'utf8'))
  if (!Array.isArray(verifyRows)) fail('cordis.patch.yml no longer parses as an array')
  const matches = verifyRows.filter(
    (row) => row !== null && typeof row === 'object' && row.id === PLUGIN_NAME)
  if (matches.length !== 1) {
    fail('expected exactly 1 mount row for ' + PLUGIN_NAME + ', found ' + String(matches.length))
  }
  const disabled = matches[0].disabled === true
  if (disabled) fail('the mount row is disabled; remove that entry and re-run')
  step('    verified: exactly 1 enabled mount row')
} else {
  step('    WARNING: no js-yaml available, so the YAML edit was not re-parsed')
}

// --- summary ---------------------------------------------------------------

console.log('\nDone. Next:')
console.log('  1. restart DSH (the client bundle is assembled at boot),')
console.log('  2. hard-refresh the DSH GUI,')
console.log('  3. hover a user message for 「修正提示词」, or use 「修改回复」')
console.log('     in an assistant message action row.')
console.log('\nBackups: *.bak-install-message-edit (only for files actually changed).')
