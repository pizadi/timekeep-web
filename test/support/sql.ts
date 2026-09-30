// Test-side SQL script handling for the D1 integration suites.
//
// Why not `D1Database.exec` for the migration files? D1's `exec` splits a
// script naively (statement-per-line accumulation), so a `--` comment line
// between statements — every migration file starts with several — aborts it
// with "SQL code did not contain a statement". Wrangler's own migration
// runner uses a proper splitter before handing statements to D1; this is the
// same thing, small enough for test use.

/**
 * Split a SQL script into individual statements: semicolons outside of single-
 * quoted string literals and comments. Full-line and trailing `--` comments are
 * dropped (none of our migrations use `--` inside a string literal). No
 * `BEGIN…END` trigger bodies exist in migrations/ — if one is ever added, this
 * needs a nesting-aware pass first.
 */
export function splitSqlStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'")
          cur += sql[++i]; // '' escaped quote
        else inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      cur += ch;
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') i++; // skip to EOL
      cur += '\n';
      continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i++; // consume the closing '/'
      continue;
    }
    if (ch === ';') {
      out.push(cur.trim());
      cur = '';
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter((s) => s.replace(/\s+/g, '').length > 0);
}
