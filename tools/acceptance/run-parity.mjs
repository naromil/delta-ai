#!/usr/bin/env node
/**
 * Acceptance gate runner for the provider dispatch refactor.
 *
 * Verifies the spec has not been edited (hash-locked sidecar), runs it, and prints one
 * GATE <PASS|FAIL> line per check from the machine-readable report. Exit code is the
 * gate's own verdict, so no shell pipeline is needed.
 */
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SPEC = 'tests/acceptance/provider-parity.test.ts'
const LOCK = 'tools/acceptance/provider-parity.sha256'

/** @returns {string} hex digest of the given text. */
function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

const expected = readFileSync(LOCK, 'utf-8').trim().split(/\s+/)[0]
const actual = sha256(readFileSync(SPEC))
if (actual !== expected) {
  console.error(`GATE FAIL spec-hash ${SPEC} changed (expected ${expected}, got ${actual})`)
  console.error('The gate is supervisor-owned. Restore it instead of editing it.')
  process.exit(2)
}

const reportDir = mkdtempSync(join(tmpdir(), 'parity-report-'))
const reportPath = join(reportDir, 'report.json')

let exitCode = 0
try {
  execFileSync('npx', ['vitest', 'run', SPEC, '--reporter=json', `--outputFile=${reportPath}`], {
    stdio: ['ignore', 'ignore', 'inherit']
  })
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

let failed = 0
let passed = 0
for (const file of report.testResults ?? []) {
  for (const test of file.assertionResults ?? []) {
    const ok = test.status === 'passed'
    if (ok) passed += 1
    else failed += 1
    console.log(`GATE ${ok ? 'PASS' : 'FAIL'} ${test.fullName}`)
    if (!ok) {
      for (const message of test.failureMessages ?? []) {
        console.log(`  ${message.split('\n').slice(0, 3).join('\n  ')}`)
      }
    }
  }
}

console.log(`GATE SUMMARY passed=${passed} failed=${failed}`)
process.exit(exitCode === 0 && failed === 0 ? 0 : 1)
