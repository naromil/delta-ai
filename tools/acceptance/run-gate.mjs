#!/usr/bin/env node
/**
 * Acceptance gate runner. One spec per gate, each hash-locked by a sidecar digest so a
 * green run also proves the checks themselves were not edited.
 *
 *   node tools/acceptance/run-gate.mjs parity
 *   node tools/acceptance/run-gate.mjs discovery
 *
 * Prints `GATE <PASS|FAIL> <test name>` per check, a summary line, and exits non-zero on any
 * failure or when the spec hash does not match.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const GATES = {
  parity: {
    spec: 'tests/acceptance/provider-parity.test.ts',
    lock: 'tools/acceptance/provider-parity.sha256'
  },
  discovery: {
    spec: 'tests/acceptance/connection-discovery.test.ts',
    lock: 'tools/acceptance/connection-discovery.sha256'
  }
}

const gateName = process.argv[2]
const gate = GATES[gateName]
if (!gate) {
  console.error(`usage: run-gate.mjs <${Object.keys(GATES).join('|')}>`)
  process.exit(2)
}
if (!existsSync(gate.lock)) {
  console.error(`GATE FAIL missing lock ${gate.lock}`)
  process.exit(2)
}

const expected = readFileSync(gate.lock, 'utf-8').trim().split(/\s+/)[0]
const actual = createHash('sha256').update(readFileSync(gate.spec)).digest('hex')
if (actual !== expected) {
  console.error(`GATE FAIL spec-hash ${gate.spec} changed (expected ${expected}, got ${actual})`)
  console.error('The gate is supervisor-owned. Restore it instead of editing it.')
  process.exit(2)
}

const reportDir = mkdtempSync(join(tmpdir(), `gate-${gateName}-`))
const reportPath = join(reportDir, 'report.json')

let exitCode = 0
try {
  execFileSync(
    'npx',
    ['vitest', 'run', gate.spec, '--reporter=json', `--outputFile=${reportPath}`],
    {
      stdio: ['ignore', 'ignore', 'inherit']
    }
  )
} catch (err) {
  exitCode = err.status ?? 1
}

let report
try {
  report = JSON.parse(readFileSync(reportPath, 'utf-8'))
} catch {
  console.error('GATE FAIL no machine-readable report produced')
  process.exit(2)
} finally {
  rmSync(reportDir, { recursive: true, force: true })
}

const suites = report.testResults ?? []
if ((report.numTotalTests ?? 0) === 0) {
  // Collection error (missing module, syntax error): the suite never ran.
  const message = suites[0]?.message ?? 'suite produced no tests'
  console.error(`GATE FAIL ${gateName} suite did not collect`)
  console.error(
    message
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .slice(0, 4)
      .join('\n')
  )
  process.exit(2)
}

let passed = 0
let failed = 0
for (const file of suites) {
  for (const test of file.assertionResults ?? []) {
    const ok = test.status === 'passed'
    if (ok) passed += 1
    else failed += 1
    console.log(`GATE ${ok ? 'PASS' : 'FAIL'} ${test.fullName}`)
    if (!ok) {
      for (const failure of test.failureMessages ?? []) {
        console.log(`  ${failure.split('\n').slice(0, 3).join('\n  ')}`)
      }
    }
  }
}

console.log(`GATE SUMMARY ${gateName} passed=${passed} failed=${failed}`)
process.exit(exitCode === 0 && failed === 0 ? 0 : 1)
