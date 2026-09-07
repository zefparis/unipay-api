/**
 * Guard test: SECURITY DEFINER functions must have REVOKE in their migration.
 *
 * Root cause of the Supabase audit finding (16 SECURITY DEFINER functions
 * executable by anon/authenticated):
 *
 *   1. Some migrations created SECURITY DEFINER functions WITHOUT any REVOKE
 *      ALL FROM PUBLIC — the functions inherited PostgreSQL's default EXECUTE
 *      grant to PUBLIC (which includes anon and authenticated).
 *
 *   2. Some migrations DID have REVOKE, but a LATER migration used
 *      CREATE OR REPLACE FUNCTION on the same function WITHOUT re-applying
 *      REVOKE. In PostgreSQL, CREATE OR REPLACE FUNCTION resets the function's
 *      ACL to default (EXECUTE to PUBLIC), silently re-exposing the function.
 *
 * This test does static analysis of migration files to catch both patterns:
 *   - Pattern A: SECURITY DEFINER function with no REVOKE in its migration
 *   - Pattern B: CREATE OR REPLACE FUNCTION without REVOKE in the same migration
 *     (re-exposes the function even if a prior migration had REVOKE)
 *
 * For the live-database check (verifies actual grants in pg_proc), run:
 *   psql "$DATABASE_URL" -f supabase/tests/20260912000000_security_definer_grants_guard.sql
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../supabase/migrations');

function readMigration(filename: string): string {
  return fs.readFileSync(path.resolve(MIGRATIONS_DIR, filename), 'utf-8');
}

function listMigrations(): string[] {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => f.endsWith('.sql'))
    .sort();
}

// Extract function names from CREATE [OR REPLACE] FUNCTION statements
function extractFunctionNames(sql: string): string[] {
  const matches = [...sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)];
  return matches.map(m => m[1]);
}

// Extract function names from REVOKE statements
function extractRevokedFunctions(sql: string): string[] {
  const matches = [...sql.matchAll(/REVOKE\s+ALL\s+ON\s+FUNCTION\s+(?:public\.)?(\w+)\s*\(/gi)];
  return matches.map(m => m[1]);
}

// Check if a function name matches the financial whitelist
function isFinancialFunction(name: string): boolean {
  return (
    name.startsWith('wallet_') ||
    name.startsWith('process_merchant_') ||
    name.startsWith('process_wallet_') ||
    name.startsWith('resolve_') ||
    name.startsWith('mark_') ||
    name.startsWith('begin_') ||
    name.startsWith('reject_')
  );
}

// Check if a migration contains SECURITY DEFINER for a given function
function functionIsSecurityDefiner(sql: string, funcName: string): boolean {
  // Find the function definition block and check for SECURITY DEFINER
  const regex = new RegExp(
    `CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${funcName}\\s*\\([\\s\\S]*?\\$\\$[\\s\\S]*?SECURITY\\s+DEFINER`,
    'i',
  );
  return regex.test(sql);
}

describe('SECURITY DEFINER guard — migration static analysis', () => {

  // ── Fix migration: 20260912010000_fix_security_definer_revokes.sql ──
  // This migration applies REVOKE to all functions that were missing it.
  // The test checks that this fix migration exists and covers all affected functions.
  const FIX_MIGRATION = '20260912010000_fix_security_definer_revokes.sql';
  const fixSql = fs.existsSync(path.resolve(MIGRATIONS_DIR, FIX_MIGRATION))
    ? readMigration(FIX_MIGRATION)
    : '';
  const fixRevokedFunctions = extractRevokedFunctions(fixSql);
  // ── Pattern A: SECURITY DEFINER without REVOKE in same migration ──
  describe('Pattern A: every SECURITY DEFINER financial function has REVOKE in its migration', () => {
    const migrations = listMigrations();

    // Collect all (migration, function) pairs where function is SECURITY DEFINER + financial
    const financialDefinerFunctions: Array<{ migration: string; func: string }> = [];

    for (const migration of migrations) {
      const sql = readMigration(migration);
      const funcNames = extractFunctionNames(sql);
      for (const func of funcNames) {
        if (isFinancialFunction(func) && functionIsSecurityDefiner(sql, func)) {
          financialDefinerFunctions.push({ migration, func });
        }
      }
    }

    it('found SECURITY DEFINER financial functions to check', () => {
      assert.ok(financialDefinerFunctions.length > 0, 'should find at least one SECURITY DEFINER financial function');
    });

    // Check each one — REVOKE must be in the same migration OR in the fix migration
    for (const { migration, func } of financialDefinerFunctions) {
      it(`${func}() in ${migration} has REVOKE ALL ON FUNCTION`, () => {
        const sql = readMigration(migration);
        const revoked = extractRevokedFunctions(sql);
        const hasRevokeInOriginal = revoked.includes(func);
        const hasRevokeInFix = fixRevokedFunctions.includes(func);
        assert.ok(
          hasRevokeInOriginal || hasRevokeInFix,
          `${migration}: SECURITY DEFINER function ${func}() must have REVOKE ALL ON FUNCTION ` +
          `in the same migration or in ${FIX_MIGRATION}. ` +
          `Without it, PostgreSQL grants EXECUTE to PUBLIC (includes anon + authenticated), ` +
          `bypassing the backend entirely.`,
        );
      });
    }
  });

  // ── Pattern B: CREATE OR REPLACE without REVOKE re-exposes functions ──
  describe('Pattern B: CREATE OR REPLACE FUNCTION re-applies REVOKE', () => {
    const migrations = listMigrations();

    // For each migration, check if it has CREATE OR REPLACE FUNCTION
    // for a financial function that was SECURITY DEFINER in a prior migration
    const allPriorFunctions = new Map<string, string>(); // func -> first migration that created it

    const reExposedCases: Array<{ migration: string; func: string; priorMigration: string }> = [];

    for (const migration of migrations) {
      const sql = readMigration(migration);
      const isReplace = /CREATE\s+OR\s+REPLACE\s+FUNCTION/i.test(sql);
      const funcNames = extractFunctionNames(sql);
      const revoked = extractRevokedFunctions(sql);

      for (const func of funcNames) {
        if (!isFinancialFunction(func)) continue;

        if (isReplace && allPriorFunctions.has(func)) {
          // This is a CREATE OR REPLACE on an existing function
          const priorMigration = allPriorFunctions.get(func)!;
          const priorSql = readMigration(priorMigration);
          const wasSecurityDefiner = functionIsSecurityDefiner(priorSql, func);
          const isStillSecurityDefiner = functionIsSecurityDefiner(sql, func) || wasSecurityDefiner;

          if (isStillSecurityDefiner && !revoked.includes(func)) {
            reExposedCases.push({ migration, func, priorMigration });
          }
        }

        // Track this migration as the latest creator/replacer
        allPriorFunctions.set(func, migration);
      }
    }

    it('no CREATE OR REPLACE FUNCTION re-exposes a SECURITY DEFINER financial function', () => {
      // Filter out cases covered by the fix migration
      const uncovered = reExposedCases.filter(c => !fixRevokedFunctions.includes(c.func));
      if (uncovered.length > 0) {
        const details = uncovered
          .map(c => `${c.func}() in ${c.migration} (originally SECURITY DEFINER in ${c.priorMigration})`)
          .join('\n  ');
        assert.fail(
          `Pattern B detected — CREATE OR REPLACE FUNCTION without REVOKE re-exposes functions:\n  ${details}\n` +
          `PostgreSQL resets ACL to default (EXECUTE to PUBLIC) on CREATE OR REPLACE. ` +
          `Add REVOKE ALL ON FUNCTION public.${uncovered[0].func}(...) FROM PUBLIC; in each migration that uses CREATE OR REPLACE ` +
          `or in ${FIX_MIGRATION}.`
        );
      }
    });
  });

  // ── Known affected migrations from our sessions ──
  describe('migrations from our sessions — REVOKE status', () => {
    const sessionMigrations = [
      '20260906020000_onchain_reconciliation.sql',
      '20260907020100_extend_callback_merchant_ledger.sql',
      '20260907020200_settlement_rpcs.sql',
      '20260908000000_merchant_multi_currency.sql',
      '20260908000100_callback_ledger_currency.sql',
    ];

    for (const migration of sessionMigrations) {
      it(`${migration} has REVOKE for every SECURITY DEFINER financial function`, () => {
        const sql = readMigration(migration);
        const funcNames = extractFunctionNames(sql);
        const revoked = extractRevokedFunctions(sql);

        const securityDefinerFinancial = funcNames.filter(
          f => isFinancialFunction(f) && functionIsSecurityDefiner(sql, f),
        );

        for (const func of securityDefinerFinancial) {
          assert.ok(
            revoked.includes(func) || fixRevokedFunctions.includes(func),
            `${migration}: ${func}() is SECURITY DEFINER but has no REVOKE in this migration or in ${FIX_MIGRATION}`,
          );
        }
      });
    }
  });

  // ── Early migrations (pre-our-sessions) ──
  describe('early migrations — REVOKE status', () => {
    const earlyMigrations = [
      '20260610180000_swap_balances.sql',
      '20260718220000_dev_expenses_v4_transactional_rpc.sql',
    ];

    for (const migration of earlyMigrations) {
      it(`${migration} has REVOKE for every SECURITY DEFINER financial function`, () => {
        const sql = readMigration(migration);
        const funcNames = extractFunctionNames(sql);
        const revoked = extractRevokedFunctions(sql);

        const securityDefinerFinancial = funcNames.filter(
          f => isFinancialFunction(f) && functionIsSecurityDefiner(sql, f),
        );

        for (const func of securityDefinerFinancial) {
          assert.ok(
            revoked.includes(func) || fixRevokedFunctions.includes(func),
            `${migration}: ${func}() is SECURITY DEFINER but has no REVOKE in this migration or in ${FIX_MIGRATION}`,
          );
        }
      });
    }
  });

  // ── Live database check instructions ──
  describe('live database verification', () => {
    it('guard SQL script exists for live database checks', () => {
      const guardPath = path.resolve(__dirname, '../../../supabase/tests/20260912000000_security_definer_grants_guard.sql');
      assert.ok(
        fs.existsSync(guardPath),
        'supabase/tests/20260912000000_security_definer_grants_guard.sql must exist',
      );
    });

    it('guard SQL script queries pg_proc for actual grants', () => {
      const guardPath = path.resolve(__dirname, '../../../supabase/tests/20260912000000_security_definer_grants_guard.sql');
      const guardSql = fs.readFileSync(guardPath, 'utf-8');
      assert.match(guardSql, /pg_proc/, 'guard must query pg_proc');
      assert.match(guardSql, /has_function_privilege/, 'guard must use has_function_privilege');
      assert.match(guardSql, /prosecdef/, 'guard must check prosecdef (SECURITY DEFINER)');
      assert.match(guardSql, /anon/, 'guard must check anon role');
      assert.match(guardSql, /authenticated/, 'guard must check authenticated role');
    });
  });
});
