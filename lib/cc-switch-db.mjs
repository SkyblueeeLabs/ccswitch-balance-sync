import { randomUUID } from 'node:crypto';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { buildUsageScript, readPlanSnapshot } from './usage-script.mjs';

function backupDatabase(path) {
  const directory = dirname(path);
  const prefix = `${basename(path, extname(path))}.backup-`;
  const destination = join(directory, `${prefix}${Date.now()}-${randomUUID()}.db`);
  const temporary = `${destination}.tmp`;
  // The caller holds a write reservation. A separate reader can capture the
  // committed database, including WAL pages, before any of our updates.
  const reader = new DatabaseSync(path, { readOnly: true });
  try {
    reader.exec('PRAGMA busy_timeout = 5000');
    reader.prepare('VACUUM INTO ?').run(temporary);
    renameSync(temporary, destination);
  } finally {
    reader.close();
    rmSync(temporary, { force: true });
  }
  return { directory, prefix };
}

function pruneBackups({ directory, prefix }) {
  const backups = readdirSync(directory)
    .filter(name => name.startsWith(prefix) && /^\d{13}(?:-[\da-f-]{36})?\.db$/.test(name.slice(prefix.length)))
    .sort()
    .reverse();
  for (const name of backups.slice(20)) rmSync(join(directory, name), { force: true });
}

function findProvider(rows, provider, appType) {
  const appRows = rows.filter(row => row.app_type === appType);
  const name = provider.matchName?.toLowerCase();
  const exact = provider.providerId
    ? appRows.filter(row => row.id === provider.providerId)
    : appRows.filter(row => row.name.toLowerCase() === name);
  const matches = exact.length || provider.providerId
    ? exact : appRows.filter(row => row.name.toLowerCase().includes(name));
  if (matches.length === 1) return { row: matches[0] };
  return { ambiguous: matches.length > 1 };
}

function matchRows(rows, provider) {
  const matched = [];
  const skipped = [];
  let ambiguous = false;
  for (const appType of provider.appTypes) {
    const found = findProvider(rows, provider, appType);
    if (found.row) matched.push({ appType, row: found.row });
    else {
      skipped.push(appType);
      ambiguous ||= found.ambiguous;
    }
  }
  return { matched, skipped, ambiguous };
}

function resolvePlan(entry, matched) {
  if (!entry.planError) return entry.plan ?? null;
  // Each record keeps its own snapshot, so fall back to the first readable one
  // and write that same plan everywhere to keep the two groups in step.
  for (const { row } of matched) {
    try {
      const previous = JSON.parse(row.meta ?? '{}')?.usage_script;
      const snapshot = readPlanSnapshot(previous?.code, entry.provider.apiUrl);
      if (snapshot) return snapshot;
    } catch {
      // Unreadable metadata is reported per record by prepareUpdate.
    }
  }
  return null;
}

function prepareUpdate(entry, row, plan, displayMode) {
  const meta = JSON.parse(row.meta ?? '{}') ?? {};
  if (typeof meta !== 'object' || Array.isArray(meta)) throw new Error('供应商元数据不是对象');
  const previous = meta.usage_script;
  const usage = {
    timeout: 10,
    autoQueryInterval: 5,
    ...previous,
    enabled: true,
    language: 'javascript',
    templateType: 'custom',
    code: buildUsageScript(entry.provider, entry.cookie, plan, displayMode),
  };
  if (JSON.stringify(previous) === JSON.stringify(usage)) return { changed: false };
  return { changed: true, meta: JSON.stringify({ ...meta, usage_script: usage }) };
}

export function updateDatabase(path, entries, readDisplayMode) {
  if (!entries.some(entry => !entry.error)) return entries;
  if (!existsSync(path)) throw new Error(`找不到 CC Switch 数据库：${path}`);
  const db = new DatabaseSync(path);
  let backup;
  let results;
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    const rows = db.prepare('SELECT id, app_type, name, meta FROM providers').all();
    const targets = entries.map(entry => matchRows(rows, entry.provider));
    const displayMode = readDisplayMode();
    const allMatched = targets.flatMap(target => target.matched);
    const updates = [];
    results = entries.map((entry, index) => {
      if (entry.error) return entry;
      const { matched, skipped, ambiguous } = targets[index];
      const label = entry.provider.providerId ?? entry.provider.matchName;
      if (!matched.length) {
        return { ...entry, error: ambiguous
          ? `「${label}」匹配了多条记录，请用 providerId 或完整名称指定目标`
          : `在 CC Switch 的 ${entry.provider.appTypes.join('、')} 中找不到「${label}」` };
      }
      if (matched.some(({ row }) => allMatched.filter(candidate => candidate.row === row).length > 1)) {
        return { ...entry, error: '多个供应商配置指向同一条 CC Switch 记录' };
      }
      const plan = resolvePlan(entry, matched);
      let pending;
      try {
        pending = matched.map(({ appType, row }) => ({
          appType, row, ...prepareUpdate(entry, row, plan, displayMode),
        }));
      } catch {
        // Nothing is queued for this provider, so a bad record leaves the others untouched.
        return { ...entry, error: '无法解析 CC Switch 元数据或已有套餐快照', plan, written: [], skipped };
      }
      for (const update of pending) if (update.changed) updates.push({ row: update.row, meta: update.meta });
      const written = pending.map(({ appType, changed }) => ({ appType, changed }));
      return { ...entry, plan, written, skipped, changed: written.some(item => item.changed) };
    });

    if (updates.length) {
      backup = backupDatabase(path);
      const statement = db.prepare('UPDATE providers SET meta = ? WHERE id = ? AND app_type = ?');
      for (const { row, meta } of updates) statement.run(meta, row.id, row.app_type);
    }
    db.exec('COMMIT');
  } finally {
    // SQLite rolls back an active transaction when the connection closes.
    db.close();
  }

  if (backup) {
    try {
      pruneBackups(backup);
    } catch {
      console.warn('无法清理旧数据库备份。');
    }
  }
  return results;
}
