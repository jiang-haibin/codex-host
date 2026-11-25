import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createZstdDecompress } from 'node:zlib';

const workspace = path.dirname(fileURLToPath(import.meta.url));
const stateDir = path.join(workspace, 'host-state');
const stockHome = path.resolve(process.env.CODEX_HISTORY_STOCK_HOME ?? path.join(homedir(), '.codex'));
const hostHome = path.join(stateDir, 'codex');
const hostData = path.join(stateDir, 'host');
const stateFile = 'state_5.sqlite';
const historyFile = 'thread_history_1.sqlite';
const globalStateFile = '.codex-global-state.json';
const databases = [stateFile, historyFile, 'goals_1.sqlite'];
const rolloutPattern = /^rollout-.+?([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})\.jsonl(?:\.zst)?$/i;
const threadIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const historyTables = ['thread_items', 'thread_turns', 'thread_realtime_items', 'thread_history_projection_state'];
const metadataTables = ['thread_attachments', 'thread_dynamic_tools'];
const localFields = new Set(['project_id', 'is_pinned', 'thread_section_id', 'section_position', 'section_entered_at_ms']);

function stamp(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false, bigint: true });
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Expected a regular file: ${file}`);
  return `${stat.size}:${stat.mtimeNs}:${stat.ino}`;
}

function inside(root, file) {
  const relative = path.relative(root, file);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Path outside its profile: ${file}`);
  }
  return relative;
}

function assertLocalPath(root, file) {
  inside(root, file);
  // Resolve existing ancestors before opening or replacing a file on Windows.
  let existing = file;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  inside(fs.realpathSync.native(root), fs.realpathSync.native(existing));
}

function filesUnder(root, dir) {
  const files = [];
  if (!fs.existsSync(dir)) return files;
  assertLocalPath(root, dir);
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...filesUnder(root, file));
    else if (entry.isFile()) files.push(file);
    else throw new Error(`Unexpected entry in conversation storage: ${file}`);
  }
  return files;
}

function rolloutFiles(root) {
  return ['sessions', 'archived_sessions'].flatMap(dir => filesUnder(root, path.join(root, dir)));
}

function rolloutIndex(files) {
  const byId = new Map();
  for (const file of files) {
    const id = rolloutPattern.exec(path.basename(file))?.[1]?.toLowerCase();
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, []);
    byId.get(id).push(file);
  }
  return byId;
}

function findRollout(row, files) {
  const candidates = files.get(row.id) ?? [];
  const logical = path.normalize(row.rollout_path.replace(/^\\\\\?\\/, ''));
  const expected = candidates.find(file => file === logical || file === `${logical}.zst`);
  return expected ?? (candidates.length === 1 ? candidates[0] : null);
}

function rolloutPath(root, relative, oldPath) {
  const logical = oldPath.endsWith('.zst') ? relative : relative.replace(/\.zst$/, '');
  return path.join(root, logical);
}

function snapshotFiles(root) {
  const files = rolloutFiles(root).map(file => inside(root, file));
  for (const name of [...databases, 'session_index.jsonl']) {
    if (fs.existsSync(path.join(root, name))) files.push(name);
    if (fs.existsSync(path.join(root, `${name}-wal`))) files.push(`${name}-wal`);
  }
  return new Map(files.sort().map(name => [name, stamp(path.join(root, name))]));
}

function openDb(file, options = {}) {
  const db = new DatabaseSync(file, options);
  db.exec('PRAGMA busy_timeout = 5000');
  return db;
}

function transaction(db, run) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = run();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function sqliteCheck(file) {
  const db = openDb(file);
  try {
    if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error(`Invalid snapshot: ${file}`);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

function copyOptional(source, target) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
}

function migrateProjects(root, finalRoot = root) {
  const file = path.join(root, globalStateFile);
  const backup = path.join(root, '.codex-global-state.before-host-projects.json');
  assertLocalPath(root, file);
  assertLocalPath(root, backup);
  if (stamp(backup)) return;
  if (root === hostHome && desktopRunning()) throw new Error('Exit Codex Desktop and CodexHost before migrating the project sidebar.');

  const sourceFile = path.join(stockHome, globalStateFile);
  assertLocalPath(stockHome, sourceFile);
  if (!stamp(sourceFile)) return;
  const source = JSON.parse(fs.readFileSync(sourceFile, 'utf8'));
  const sourceProjects = Object.entries(source['local-projects'] ?? {});
  if (!sourceProjects.length) return;

  const version = stamp(file);
  const previous = version ? fs.readFileSync(file, 'utf8') : '{}';
  const target = JSON.parse(previous);
  const currentProjects = target['local-projects'] ?? {};
  // Linked projects already have a local ID. Skip their old ChatGPT-ID aliases.
  const aliases = new Set(sourceProjects.map(([, project]) => project.chatGptBacking?.projectId).filter(Boolean));
  const imported = Object.fromEntries(sourceProjects.filter(([id]) => !aliases.has(id)));
  const projects = target['local-projects'] = { ...imported, ...currentProjects };

  const mergeOrder = (current = [], incoming = []) => [...new Set([...current, ...incoming])];
  for (const key of ['project-order', 'pinned-project-ids']) {
    target[key] = mergeOrder(target[key], source[key]?.filter(id => Object.hasOwn(projects, id)));
  }
  target['project-appearances'] = { ...source['project-appearances'], ...target['project-appearances'] };
  const atomsKey = 'electron-persisted-atom-state';
  const orderKey = 'unified-sidebar-project-order-v1';
  if (source[atomsKey]?.[orderKey]) {
    const atoms = target[atomsKey] ??= {};
    atoms[orderKey] = mergeOrder(atoms[orderKey], source[atomsKey][orderKey]);
  }

  const database = path.join(root, stateFile);
  assertLocalPath(root, database);
  if (!stamp(database)) throw new Error(`Missing Codex database: ${database}`);
  const staged = `${file}.${process.pid}.projects-tmp`;
  const stagedBackup = `${backup}.${process.pid}.tmp`;
  const db = openDb(database);
  let restored = 0;
  try {
    transaction(db, () => {
      const mappingKey = 'app-server-project-id-by-legacy-project-id-by-host';
      const localKey = `local:${finalRoot}`;
      const maps = target[mappingKey] ??= {};
      const serverProjects = new Set(db.prepare('SELECT id FROM projects').all().map(row => row.id));
      const stockMap = Object.entries(source[mappingKey]?.[`local:${stockHome}`] ?? {});
      const matching = stockMap.filter(([id, serverId]) => Object.hasOwn(projects, id) && serverProjects.has(serverId));
      const mappings = maps[localKey] = { ...Object.fromEntries(matching), ...maps[localKey] };

      const threads = new Map(db.prepare('SELECT id, project_id FROM threads').all().map(row => [row.id, row.project_id]));
      const assignmentKey = 'thread-project-assignments';
      const membershipKey = 'thread-project-membership-host-ids';
      const assignments = target[assignmentKey] ??= {};
      const memberships = target[membershipKey] ??= {};
      const projectless = new Set(target['projectless-thread-ids'] ?? []);
      const assign = db.prepare('UPDATE threads SET project_id = ? WHERE id = ? AND project_id IS NULL');
      for (const [id, project] of Object.entries(source[assignmentKey] ?? {})) {
        if (!threads.has(id) || project.projectKind !== 'local' || !Object.hasOwn(projects, project.projectId)
          || (source[membershipKey]?.[id] ?? 'local') !== 'local' || Object.hasOwn(assignments, id) || projectless.has(id)) continue;
        const serverId = mappings[project.projectId];
        const assigned = threads.get(id);
        if (assigned && assigned !== serverId) continue;
        if (!assigned && serverProjects.has(serverId)) restored += assign.run(serverId, id).changes;
        assignments[id] = project;
        memberships[id] = 'local';
      }
      const threadOrderKey = 'sidebar-project-thread-orders';
      const orders = Object.entries(source[threadOrderKey] ?? {}).map(([id, order]) => [id,
        { ...order, threadIds: (order.threadIds ?? []).filter(threadId => threads.has(threadId)) }]);
      target[threadOrderKey] = { ...Object.fromEntries(orders), ...target[threadOrderKey] };

      fs.writeFileSync(staged, JSON.stringify(target), { flag: 'wx' });
      fs.writeFileSync(stagedBackup, previous, { flag: 'wx' });
      if (stamp(file) !== version || (root === hostHome && desktopRunning())) {
        throw new Error('Host sidebar state changed while preparing the project migration.');
      }
    });
    fs.renameSync(staged, file);
    // The backup also marks a completed migration so future launches keep Host's own project edits.
    fs.renameSync(stagedBackup, backup);
    console.log(JSON.stringify({ projectsAdded: Object.keys(imported).filter(id => !Object.hasOwn(currentProjects, id)).length,
      projectAssignmentsRestored: restored }));
  } finally {
    db.close();
    for (const pending of [staged, stagedBackup]) if (fs.existsSync(pending)) fs.unlinkSync(pending);
  }
}

function migrate() {
  if (fs.existsSync(stateDir)) throw new Error(`Host data already exists: ${stateDir}`);
  const staging = `${stateDir}.staging`;
  fs.mkdirSync(staging);
  try {
    const copy = path.join(staging, 'codex');
    fs.mkdirSync(copy);
    let previous = new Map();
    let original;
    for (let attempt = 0; attempt < 8; attempt++) {
      original = snapshotFiles(stockHome);
      for (const [relative, version] of original) {
        if (version === previous.get(relative)) continue;
        const target = path.join(copy, relative);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(path.join(stockHome, relative), target);
      }
      for (const relative of previous.keys()) {
        if (!original.has(relative)) fs.unlinkSync(path.join(copy, relative));
      }
      if (JSON.stringify([...original]) === JSON.stringify([...snapshotFiles(stockHome)])) break;
      if (attempt === 7) throw new Error('Codex history kept changing during the snapshot. Retry when turns are idle.');
      previous = original;
    }
    for (const name of databases) sqliteCheck(path.join(copy, name));
    const files = rolloutIndex(rolloutFiles(copy));
    const db = openDb(path.join(copy, stateFile));
    let count;
    try {
      count = transaction(db, () => {
        const rows = db.prepare('SELECT id, rollout_path FROM threads').all();
        const update = db.prepare('UPDATE threads SET rollout_path = ? WHERE id = ?');
        for (const row of rows) {
          const relative = inside(stockHome, path.normalize(row.rollout_path.replace(/^\\\\\?\\/, '')));
          const inCopy = { ...row, rollout_path: path.join(copy, relative) };
          const file = findRollout(inCopy, files);
          if (!file) throw new Error(`Could not resolve a unique rollout for ${row.id}`);
          update.run(rolloutPath(hostHome, inside(copy, file), row.rollout_path), row.id);
        }
        return rows.length;
      });
    } finally {
      db.close();
    }
    for (const name of ['config.toml', 'AGENTS.md', 'attachments', 'generated_images']) {
      copyOptional(path.join(stockHome, name), path.join(copy, name));
    }
    migrateProjects(copy, hostHome);
    const nativeCopy = path.join(staging, 'host');
    fs.mkdirSync(nativeCopy);
    const nativeHome = path.join(path.dirname(stockHome), '.codexhost');
    for (const name of ['mapping-store', 'antigravity-history', 'harness-launch-settings', 'harness-display-settings-v1.json', 'plugins']) {
      copyOptional(path.join(nativeHome, name), path.join(nativeCopy, name));
    }
    migrateWorkBuddy(nativeCopy);
    // Keep the original file stamps so the first incremental pass can recognize its common ancestor.
    fs.writeFileSync(path.join(staging, 'migration-files.json'), JSON.stringify([...original]));
    assertLocalPath(workspace, staging);
    assertLocalPath(workspace, stateDir);
    fs.renameSync(staging, stateDir);
    console.log(`Migrated ${count} indexed threads and ${[...original].filter(([name]) => rolloutPattern.test(path.basename(name))).length} rollout files.`);
  } catch (error) {
    assertLocalPath(workspace, staging);
    fs.rmSync(staging, { recursive: true });
    throw error;
  }
}

function attach(db, root, name, alias, writable) {
  const file = path.join(root, name);
  assertLocalPath(root, file);
  if (!stamp(file)) throw new Error(`Missing Codex database: ${file}`);
  db.prepare(`ATTACH DATABASE ? AS ${alias}`).run(`${pathToFileURL(file).href}?mode=${writable ? 'rw' : 'ro'}`);
}

function openProfile(root, writable = false, incoming) {
  const db = openDb(':memory:');
  try {
    attach(db, root, stateFile, 'state', writable);
    attach(db, root, historyFile, 'history', writable);
    if (incoming) {
      attach(db, incoming, stateFile, 'incoming', false);
      attach(db, incoming, historyFile, 'incoming_history', false);
      for (const [schema, other, tables] of [
        ['state', 'incoming', ['threads', 'thread_spawn_edges', ...metadataTables]],
        ['history', 'incoming_history', historyTables],
      ]) {
        for (const table of tables) {
          const columns = db.prepare(`PRAGMA ${schema}.table_info(${table})`).all();
          const source = db.prepare(`PRAGMA ${other}.table_info(${table})`).all();
          if (!columns.length || JSON.stringify(columns) !== JSON.stringify(source)) {
            throw new Error(`Codex database schemas differ for ${table}. Open both apps with the same Codex version first.`);
          }
        }
      }
    }
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function threadQuery(state, history) {
  return `SELECT t.*, p.next_rollout_byte_offset AS sync_offset, p.next_rollout_ordinal AS sync_ordinal,
      (SELECT status FROM ${history}.thread_turns WHERE thread_id = t.id ORDER BY rollout_ordinal DESC LIMIT 1) AS sync_status
    FROM ${state}.threads t LEFT JOIN ${history}.thread_history_projection_state p ON p.thread_id = t.id`;
}

function describe(root, row, file) {
  const relative = file ? inside(root, file) : null;
  const { rollout_path, ...rest } = row;
  const shared = Object.entries(rest).filter(([key]) => !localFields.has(key));
  const content = sha(JSON.stringify([relative, shared]));
  return { root, row, file, relative, content, version: `${content}:${file ? stamp(file) : ''}` };
}

function scan(root, db) {
  const files = rolloutIndex(rolloutFiles(root));
  return new Map(db.prepare(threadQuery('state', 'history')).all().map(row => [row.id, describe(root, row, findRollout(row, files))]));
}

function openLedger() {
  const db = openDb(path.join(stateDir, 'sync.sqlite'));
  db.exec(`CREATE TABLE IF NOT EXISTS baseline (id TEXT PRIMARY KEY, stock TEXT, host TEXT);
    CREATE TABLE IF NOT EXISTS private_moves (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sidebar_updates (id TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS sidebar_cleanups (id TEXT PRIMARY KEY);`);
  if (!db.prepare('SELECT 1 FROM baseline LIMIT 1').get()) {
    const original = new Map(JSON.parse(fs.readFileSync(path.join(stateDir, 'migration-files.json'), 'utf8')));
    const profile = openProfile(hostHome);
    try {
      const save = db.prepare('INSERT OR IGNORE INTO baseline VALUES (?, ?, ?)');
      transaction(db, () => {
        for (const [id, entry] of scan(hostHome, profile)) {
          const source = original.get(entry.relative);
          if (source) save.run(id, `${entry.content}:${source}`, entry.version);
        }
      });
    } finally {
      profile.close();
    }
  }
  return db;
}

function nativeThreads() {
  const files = filesUnder(hostData, path.join(hostData, 'mapping-store'));
  return new Set(files.filter(file => file.endsWith('.json')).flatMap(file => {
    const mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
    return mapping.harnessId && mapping.hostThreadId ? [mapping.hostThreadId] : [];
  }));
}

function nativeMappings(directory) {
  const root = path.join(directory, 'mapping-store', 'threads');
  return filesUnder(directory, root).filter(file => file.endsWith('.json')).map(file => {
    const mapping = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (mapping.hostThreadId !== path.basename(file, '.json') || !threadIdPattern.test(mapping.hostThreadId)) {
      throw new Error(`Invalid native thread mapping: ${file}`);
    }
    return mapping;
  });
}

function workBuddyHistory(mapping) {
  const id = mapping.nativeSessionRef?.nativeSessionId;
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,199}$/.test(id) || !mapping.cwd) return null;
  // The bundled adapter derives the project folder from the original working directory.
  const project = mapping.cwd.replace(/[/\\:]/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  return path.join('projects', project, `${id}.jsonl`);
}

function hasNativeHistory(directory, mapping) {
  const id = mapping.nativeSessionRef?.nativeSessionId;
  if (mapping.state !== 'ready' || !id) return false;
  if (mapping.harnessId === 'antigravity') {
    const file = path.join(directory, 'antigravity-history', `${mapping.hostThreadId}.json`);
    if (!stamp(file)) return false;
    const history = JSON.parse(fs.readFileSync(file, 'utf8'));
    return history.nativeSessionId === id && Array.isArray(history.turns) && history.turns.length > 0;
  }
  if (mapping.harnessId !== 'workbuddy') return false;
  const relative = workBuddyHistory(mapping);
  if (!relative) return false;
  const file = path.join(directory, 'workbuddy', relative);
  if (!stamp(file)) return false;
  const rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  return rows.some(row => row.sessionId === id && row.type === 'message');
}

function migrateWorkBuddy(directory) {
  let copied = 0;
  for (const mapping of nativeMappings(directory)) {
    if (mapping.harnessId !== 'workbuddy' || hasNativeHistory(directory, mapping)) continue;
    const relative = workBuddyHistory(mapping);
    if (!relative) continue;
    const roots = ['.workbuddy-ai', '.workbuddy'].map(name => path.join(path.dirname(stockHome), name));
    const candidates = roots.map(root => path.join(root, relative)).filter(file => stamp(file));
    if (candidates.length !== 1) continue;
    const [source] = candidates;
    const target = path.join(directory, 'workbuddy', relative);
    assertLocalPath(directory, target);
    const before = stamp(source);
    const bytes = fs.readFileSync(source);
    if (stamp(source) !== before) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { flag: 'wx' });
    copyOptional(source.slice(0, -'.jsonl'.length), target.slice(0, -'.jsonl'.length));
    if (!hasNativeHistory(directory, mapping)) throw new Error(`Native history did not match ${mapping.hostThreadId}`);
    copied++;
  }
  return copied;
}

function parentId(row) {
  if (row.source.startsWith('{')) return JSON.parse(row.source).subagent?.thread_spawn?.parent_thread_id;
  return row.attached_thread_parent_id;
}

function isInternal(row) {
  return row.model === 'codex-auto-review' && row.source.includes('"guardian"');
}

async function modelPolicy(entry, native) {
  const { row, file } = entry;
  if (native.has(row.id)) return 'other';
  if (isInternal(row)) return 'internal';
  const gpt = /^(?:gpt-(?:\d|oss)|chatgpt-|codex-mini-latest$)/i;
  if (row.model && !gpt.test(row.model)) return 'other';
  if (!file) return 'unknown';
  let found = Boolean(row.model);
  const input = fs.createReadStream(file);
  const decoded = file.endsWith('.zst') ? createZstdDecompress() : input;
  if (decoded !== input) input.on('error', error => decoded.destroy(error)).pipe(decoded);
  try {
    for await (const line of createInterface({ input: decoded, crlfDelay: Infinity })) {
      if (!line.includes('"turn_context"')) continue;
      const event = JSON.parse(line);
      const model = event.type === 'turn_context' ? event.payload?.model : null;
      if (!model) continue;
      if (!gpt.test(model)) return 'other';
      found = true;
    }
  } finally {
    input.destroy();
    decoded.destroy();
  }
  return found ? 'gpt' : 'unknown';
}

async function isShared(entry, threads, native) {
  const visited = new Set();
  for (let current = entry; current; ) {
    const id = current.row.id;
    if (visited.has(id) || await modelPolicy(current, native) !== 'gpt') return false;
    visited.add(id);
    const parent = parentId(current.row);
    if (!parent) return true;
    current = threads.get(parent);
  }
  return false;
}

function ready(entry, { forWrite = false, quietMs = 15000 } = {}) {
  if (!entry?.file) return false;
  const lock = path.join(entry.root, 'thread-writer-locks', `${entry.row.id}.lock`);
  const status = entry.row.sync_status;
  // An open conversation can keep its writer lock long after a turn completes.
  const finished = ['completed', 'failed', 'interrupted'].includes(status);
  if (fs.existsSync(lock) && (forWrite || !finished)) return false;
  const age = Date.now() - fs.statSync(entry.file).mtimeMs;
  // Archived rollouts can retain an interrupted turn's old status after the writer is gone.
  return age >= quietMs && (status !== 'inProgress' || (entry.row.archived && age >= 86400000));
}

function copyThreadRows(db, row, rollout) {
  const clean = Object.fromEntries(Object.entries(row).filter(([key]) => !key.startsWith('sync_')));
  clean.rollout_path = rollout;
  if (clean.project_id && !db.prepare('SELECT 1 FROM state.projects WHERE id = ?').get(clean.project_id)) clean.project_id = null;
  Object.assign(clean, { is_pinned: 0, thread_section_id: null, section_position: null, section_entered_at_ms: null });
  const names = Object.keys(clean).map(name => `"${name}"`);
  const updates = Object.keys(clean).filter(key => key !== 'id' && !localFields.has(key));
  db.prepare(`INSERT INTO state.threads (${names}) VALUES (${names.map(() => '?')}) ON CONFLICT(id) DO UPDATE SET
    ${updates.map(name => `"${name}" = excluded."${name}"`)}`).run(...Object.values(clean));

  for (const [target, source, tables] of [['state', 'incoming', metadataTables], ['history', 'incoming_history', historyTables]]) {
    for (const table of tables) {
      db.prepare(`DELETE FROM ${target}.${table} WHERE thread_id = ?`).run(row.id);
      db.prepare(`INSERT INTO ${target}.${table} SELECT * FROM ${source}.${table} WHERE thread_id = ?`).run(row.id);
    }
  }
  db.prepare(`INSERT INTO state.thread_spawn_edges
    SELECT parent_thread_id, child_thread_id, status FROM incoming.thread_spawn_edges
    WHERE (parent_thread_id = ? OR child_thread_id = ?)
      AND parent_thread_id IN (SELECT id FROM state.threads) AND child_thread_id IN (SELECT id FROM state.threads)
    ON CONFLICT(child_thread_id) DO UPDATE SET status = excluded.status`).run(row.id, row.id);
}

function transfer(db, sourceRoot, source, targetRoot, target) {
  const { id } = source.row;
  const destination = path.join(targetRoot, source.relative);
  const finalRollout = rolloutPath(targetRoot, source.relative, source.row.rollout_path);
  assertLocalPath(targetRoot, destination);
  if (target?.file !== destination && fs.existsSync(destination)) throw new Error(`Duplicate target rollout: ${id}`);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = `${destination}.${process.pid}.sync-tmp`;
  const backup = `${destination}.${process.pid}.sync-bak`;
  let published = false;
  let backedUp = false;
  try {
    fs.copyFileSync(source.file, staging, fs.constants.COPYFILE_EXCL);
    transaction(db, () => {
      const incoming = db.prepare(`${threadQuery('incoming', 'incoming_history')} WHERE t.id = ?`).get(id);
      const existing = db.prepare(`${threadQuery('state', 'history')} WHERE t.id = ?`).get(id);
      if (!incoming || describe(sourceRoot, incoming, source.file).version !== source.version
        || (existing && describe(targetRoot, existing, target?.file).version) !== target?.version) {
        throw new Error(`Conversation changed during transfer: ${id}`);
      }
      copyThreadRows(db, incoming, finalRollout);
      if (target?.file === destination) {
        fs.copyFileSync(destination, backup, fs.constants.COPYFILE_EXCL);
        backedUp = true;
      }
      if (!ready(source) || describe(sourceRoot, incoming, source.file).version !== source.version
        || (target && (!ready(target, { forWrite: true }) || describe(targetRoot, target.row, target.file).version !== target.version))) {
        throw new Error(`Conversation became active during transfer: ${id}`);
      }
      fs.renameSync(staging, destination);
      published = true;
    });
  } catch (error) {
    if (published && backedUp) {
      fs.renameSync(backup, destination);
      backedUp = false;
    } else if (published) fs.unlinkSync(destination);
    throw error;
  } finally {
    if (fs.existsSync(staging)) fs.unlinkSync(staging);
    if (backedUp) fs.unlinkSync(backup);
  }
  // A move between active and archived directories leaves the previous path until the new one is committed.
  if (target?.file && target.file !== destination && target.version === describe(targetRoot, target.row, target.file).version) {
    assertLocalPath(targetRoot, target.file);
    fs.unlinkSync(target.file);
  }
  const row = db.prepare(`${threadQuery('state', 'history')} WHERE t.id = ?`).get(id);
  return describe(targetRoot, row, destination);
}

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function sameThread(stock, host) {
  return Boolean(stock?.file && host?.file && stock.content === host.content
    && fs.statSync(stock.file).size === fs.statSync(host.file).size
    && await fileHash(stock.file) === await fileHash(host.file));
}

async function sync() {
  const ledger = openLedger();
  const open = [];
  let privateMoves;
  try {
    ledger.exec('BEGIN IMMEDIATE'); // Serialize the scheduled task and any manual sync.
    const stockDb = openProfile(stockHome, true, hostHome);
    open.push(stockDb);
    const hostDb = openProfile(hostHome, true, stockHome);
    open.push(hostDb);
    const stock = scan(stockHome, stockDb);
    const host = scan(hostHome, hostDb);
    const native = nativeThreads();
    const baseline = new Map(ledger.prepare('SELECT * FROM baseline').all().map(row => [row.id, row]));
    const save = ledger.prepare('INSERT OR REPLACE INTO baseline VALUES (?, ?, ?)');
    const queueMove = ledger.prepare('INSERT OR IGNORE INTO private_moves VALUES (?)');
    const queueSidebarUpdate = ledger.prepare('INSERT OR IGNORE INTO sidebar_updates VALUES (?)');
    let imported = 0;
    let exported = 0;
    const conflicts = [];
    let deferred = 0;
    for (const id of new Set([...stock.keys(), ...host.keys()])) {
      const a = stock.get(id);
      const b = host.get(id);
      if ((a && isInternal(a.row)) || (b && isInternal(b.row))) continue;
      const before = baseline.get(id);
      const stockChanged = (a?.version ?? null) !== (before?.stock ?? null);
      const hostChanged = (b?.version ?? null) !== (before?.host ?? null);
      if (!stockChanged && !hostChanged) continue;
      // A missing previously-synced record represents a local deletion. Never resurrect it.
      if ((!a && before?.stock) || (!b && before?.host)) continue;
      if (stockChanged && hostChanged) {
        if (await sameThread(a, b)) {
          if (await isShared(b, host, native)) queueSidebarUpdate.run(id);
          save.run(id, a.version, b.version);
        } else conflicts.push(id);
        continue;
      }
      const source = stockChanged ? a : b;
      const target = stockChanged ? b : a;
      if (!ready(source) || (target && !ready(target, { forWrite: true }))) {
        deferred++;
        continue;
      }
      try {
        if (stockChanged) {
          const policy = await modelPolicy(a, native);
          const importedThread = transfer(hostDb, stockHome, a, hostHome, b);
          host.set(id, importedThread);
          save.run(id, a.version, importedThread.version);
          if (policy === 'other') queueMove.run(id);
          if (policy === 'gpt') queueSidebarUpdate.run(id);
          imported++;
        } else if (await isShared(b, host, native) && !native.has(id)) {
          const exportedThread = transfer(stockDb, hostHome, b, stockHome, a);
          stock.set(id, exportedThread);
          queueSidebarUpdate.run(id);
          save.run(id, exportedThread.version, b.version);
          exported++;
        } else if (!a) save.run(id, null, b.version);
      } catch (error) {
        console.error(`Deferred ${id}: ${error.message}`);
        deferred++;
      }
    }
    privateMoves = ledger.prepare('SELECT id FROM private_moves').all().map(row => row.id);
    ledger.exec('COMMIT');
    console.log(JSON.stringify({ codexToHost: imported, hostToCodex: exported, deferred, conflicts }));
  } finally {
    for (const db of open) db.close();
    ledger.close();
  }
  try {
    publishSidebars();
  } catch (error) {
    console.error(`Sidebar updates will be retried: ${error.message}`);
    process.exitCode = 1;
  }
  if (privateMoves.length) await prune({ apply: true, requested: privateMoves });
  cleanSidebar();
}

// Resolve reported conflicts by keeping the official Codex copy and overwriting the Host copy.
async function resolveConflicts(ids) {
  if (!ids.length) throw new Error('Usage: node codex-history.mjs resolve <thread-id> [...]');
  for (const id of ids) if (!threadIdPattern.test(id)) throw new Error(`Invalid thread id: ${id}`);
  const ledger = openLedger();
  const open = [];
  try {
    ledger.exec('BEGIN IMMEDIATE');
    const stockDb = openProfile(stockHome, true, hostHome);
    open.push(stockDb);
    const hostDb = openProfile(hostHome, true, stockHome);
    open.push(hostDb);
    const stock = scan(stockHome, stockDb);
    const host = scan(hostHome, hostDb);
    const save = ledger.prepare('INSERT OR REPLACE INTO baseline VALUES (?, ?, ?)');
    const queueSidebarUpdate = ledger.prepare('INSERT OR IGNORE INTO sidebar_updates VALUES (?)');
    const backupDir = path.join(workspace, 'backups', `conflict-resolve-${new Date().toISOString().replace(/[:.]/gu, '-')}`);
    const resolved = [];
    for (const id of ids) {
      const source = stock.get(id);
      const target = host.get(id);
      if (!source?.file || !target?.file) throw new Error(`Conflict resolution needs both Codex and Host copies: ${id}`);
      // Never overwrite a conversation that is still being written.
      if (!ready(source) || !ready(target, { forWrite: true })) throw new Error(`Conversation is still active: ${id}`);
      fs.mkdirSync(backupDir, { recursive: true });
      fs.copyFileSync(target.file, path.join(backupDir, path.basename(target.file)), fs.constants.COPYFILE_EXCL);
      fs.writeFileSync(path.join(backupDir, `${id}.host-row.json`), JSON.stringify(target.row, null, 2), { flag: 'wx' });
      const imported = transfer(hostDb, stockHome, source, hostHome, target);
      save.run(id, source.version, imported.version);
      queueSidebarUpdate.run(id);
      resolved.push(id);
    }
    ledger.exec('COMMIT');
    console.log(JSON.stringify({ resolvedStockWins: resolved, hostBackup: resolved.length ? backupDir : null }));
  } finally {
    for (const db of open) db.close();
    ledger.close();
  }
  publishSidebars();
  cleanSidebar();
}

function descendants(db) {  const children = new Map();
  const edges = db.prepare('SELECT parent_thread_id, child_thread_id FROM state.thread_spawn_edges').all();
  for (const row of db.prepare('SELECT id, source, attached_thread_parent_id FROM state.threads').all()) {
    const parent = parentId(row);
    if (parent) edges.push({ parent_thread_id: parent, child_thread_id: row.id });
  }
  for (const edge of edges) {
    if (!children.has(edge.parent_thread_id)) children.set(edge.parent_thread_id, new Set());
    children.get(edge.parent_thread_id).add(edge.child_thread_id);
  }
  return root => {
    const ids = new Set([root]);
    for (const id of ids) for (const child of children.get(id) ?? []) ids.add(child);
    return [...ids];
  };
}

async function stockOnly(threads, requested = threads.keys()) {
  const native = nativeThreads();
  const ids = [];
  for (const id of requested) {
    const entry = threads.get(id);
    if (!entry) continue;
    if (await modelPolicy(entry, native) === 'other') ids.push(id);
  }
  return ids;
}

function verifiedRows(db, id) {
  for (const [target, source, tables] of [
    ['state', 'incoming', metadataTables],
    ['history', 'incoming_history', historyTables],
    ['goals', 'incoming_goals', ['thread_goals', 'thread_goal_continuation_deferrals']],
  ]) {
    for (const table of tables) {
      for (const [left, right] of [[target, source], [source, target]]) {
        if (db.prepare(`SELECT * FROM ${left}.${table} WHERE thread_id = ?
          EXCEPT SELECT * FROM ${right}.${table} WHERE thread_id = ? LIMIT 1`).get(id, id)) return false;
      }
    }
  }
  return true;
}

function codexExecutable() {
  if (process.env.CODEX_HISTORY_CODEX) return process.env.CODEX_HISTORY_CODEX;
  const installed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$app = Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1; if ($app) { Join-Path $app.InstallLocation 'app\\resources\\codex.exe' }",
  ], { encoding: 'utf8', windowsHide: true }).stdout?.trim();
  return installed && fs.existsSync(installed) ? installed : 'codex.exe';
}

async function prune({ apply = false, requested } = {}) {
  if (!apply) {
    const db = openProfile(hostHome);
    try {
      const threads = scan(hostHome, db);
      const ids = await stockOnly(threads);
      console.log(JSON.stringify({ total: threads.size, nonGpt: ids.length }));
    } finally {
      db.close();
    }
    return;
  }

  const ledger = openLedger();
  let db;
  try {
    ledger.exec('BEGIN IMMEDIATE');
    db = openProfile(stockHome, false, hostHome);
    attach(db, stockHome, 'goals_1.sqlite', 'goals', false);
    attach(db, hostHome, 'goals_1.sqlite', 'incoming_goals', false);
    const stock = scan(stockHome, db);
    const hostDb = openProfile(hostHome);
    let host;
    try {
      host = scan(hostHome, hostDb);
    } finally {
      hostDb.close();
    }
    const children = descendants(db);
    const candidates = new Set(await stockOnly(stock, requested));
    const refreshStock = db.prepare(`${threadQuery('state', 'history')} WHERE t.id = ?`);
    const refreshHost = db.prepare(`${threadQuery('incoming', 'incoming_history')} WHERE t.id = ?`);
    const deleted = new Set();
    const deferred = [];
    let executable;
    for (const id of candidates) {
      if (deleted.has(id)) continue;
      const group = children(id);
      let verified = true;
      for (const member of group) {
        if (deleted.has(member)) continue;
        const a = stock.get(member);
        const b = host.get(member);
        const freshStock = refreshStock.get(member);
        const freshHost = refreshHost.get(member);
        if (!freshStock || !freshHost || !ready(a, { forWrite: true, quietMs: 60000 }) || !await sameThread(a, b) || !verifiedRows(db, member)
          || describe(stockHome, freshStock, a.file).version !== a.version
          || describe(hostHome, freshHost, b.file).version !== b.version) {
          verified = false;
          break;
        }
        assertLocalPath(stockHome, a.file);
        assertLocalPath(stockHome, path.normalize(a.row.rollout_path.replace(/^\\\\\?\\/, '')));
      }
      if (!verified) {
        deferred.push(id);
        continue;
      }
      executable ??= codexExecutable();
      const child = spawn(executable, ['delete', id, '--force'], {
        env: { ...process.env, CODEX_HOME: stockHome, CODEX_SQLITE_HOME: stockHome },
        windowsHide: true,
        stdio: 'ignore',
      });
      const code = await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', resolve);
      });
      if (code !== 0) {
        deferred.push(id);
        continue;
      }
      for (const member of group) {
        if (!db.prepare('SELECT 1 FROM state.threads WHERE id = ?').get(member)
          && !fs.existsSync(stock.get(member).file)
          && historyTables.every(table => !db.prepare(`SELECT 1 FROM history.${table} WHERE thread_id = ? LIMIT 1`).get(member))) {
          deleted.add(member);
        }
      }
      if (!deleted.has(id)) deferred.push(id);
    }
    const finishMove = ledger.prepare('DELETE FROM private_moves WHERE id = ?');
    const queueMove = ledger.prepare('INSERT OR IGNORE INTO private_moves VALUES (?)');
    for (const id of requested ?? []) if (!candidates.has(id)) finishMove.run(id);
    const queueSidebarCleanup = ledger.prepare('INSERT OR IGNORE INTO sidebar_cleanups VALUES (?)');
    for (const id of deleted) {
      finishMove.run(id);
      queueSidebarCleanup.run(id);
    }
    for (const id of deferred) queueMove.run(id);
    ledger.exec('COMMIT');
    console.log(JSON.stringify({ nonGpt: candidates.size, removedFromCodex: deleted.size, deferred }));
    if (deferred.length) process.exitCode = 2;
  } finally {
    db?.close();
    ledger.close();
  }
}

function sidebarFiles() {
  return [globalStateFile, `${globalStateFile}.bak`].map(name => path.join(stockHome, name))
    .filter(file => stamp(file));
}

function sidebarCatalogs(root = stockHome) {
  return ['codex.db', 'codex-dev.db'].map(name => path.join(root, 'sqlite', name)).filter(file => stamp(file));
}

function catalogTable(db, table) {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?").get(table));
}

function catalogReferences(file) {
  assertLocalPath(stockHome, file);
  const db = openDb(file, { readOnly: true });
  try {
    if (!catalogTable(db, 'local_thread_catalog')) return [];
    return db.prepare("SELECT thread_id FROM local_thread_catalog WHERE host_id = 'local'").all().map(row => row.thread_id);
  } finally {
    db.close();
  }
}

function publishSidebar(root, ids) {
  const files = sidebarCatalogs(root);
  if (!files.length) return;
  const profile = openProfile(root);
  let threads;
  try {
    const read = profile.prepare('SELECT * FROM state.threads WHERE id = ?');
    threads = ids.map(id => ({ id, row: read.get(id) }));
  } finally {
    profile.close();
  }
  for (const file of files) {
    assertLocalPath(root, file);
    const catalog = openDb(file);
    try {
      if (!catalogTable(catalog, 'local_thread_catalog')) continue;
      transaction(catalog, () => {
        const syncState = catalog.prepare("SELECT observation_sequence FROM local_thread_catalog_sync_state WHERE host_id = 'local'").get();
        if (!syncState) return; // The desktop builds a fresh catalog from the thread database on first use.
        const sequence = syncState.observation_sequence + 1;
        const remove = catalog.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
        const upsert = catalog.prepare(`INSERT INTO local_thread_catalog (
          host_id, thread_id, display_title, source_created_at, source_updated_at, source_recency_at,
          cwd, source_kind, thread_source, model_provider, git_branch, project_id, observation_sequence
        ) VALUES ('local', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id, thread_id) DO UPDATE SET display_title = excluded.display_title,
          source_updated_at = excluded.source_updated_at, source_recency_at = excluded.source_recency_at,
          cwd = excluded.cwd, model_provider = excluded.model_provider, git_branch = excluded.git_branch,
          project_id = excluded.project_id, observation_sequence = excluded.observation_sequence,
          missing_candidate = 0, pending_observed_title = 0
        WHERE excluded.source_updated_at >= local_thread_catalog.source_updated_at AND (
          local_thread_catalog.pending_observed_title = 0
          OR excluded.source_updated_at > local_thread_catalog.source_updated_at
          OR excluded.display_title = local_thread_catalog.display_title
        ) AND (
          excluded.source_updated_at IS NOT local_thread_catalog.source_updated_at
          OR excluded.source_recency_at IS NOT local_thread_catalog.source_recency_at
          OR excluded.display_title IS NOT local_thread_catalog.display_title
          OR excluded.cwd IS NOT local_thread_catalog.cwd
          OR excluded.model_provider IS NOT local_thread_catalog.model_provider
          OR excluded.git_branch IS NOT local_thread_catalog.git_branch
          OR excluded.project_id IS NOT local_thread_catalog.project_id
          OR local_thread_catalog.missing_candidate = 1
        )`);
        let changed = 0;
        for (const { id, row } of threads) {
          if (!row || row.archived) changed += remove.run(id).changes;
          else if (!row.source.startsWith('{') && !parentId(row)) {
            changed += upsert.run(id, row.name || row.title || 'New thread', row.created_at, row.updated_at,
              row.recency_at || row.updated_at, row.cwd, row.source, row.thread_source, row.model_provider,
              row.git_branch, row.project_id, sequence).changes;
          }
        }
        if (!changed) return;
        catalog.prepare("UPDATE local_thread_catalog_sync_state SET observation_sequence = ? WHERE host_id = 'local'").run(sequence);
        catalog.exec('UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1');
      });
    } finally {
      catalog.close();
    }
  }
}

function publishSidebars() {
  const ledger = openLedger();
  try {
    transaction(ledger, () => {
      const ids = ledger.prepare('SELECT id FROM sidebar_updates').all().map(row => row.id);
      if (!ids.length) return;
      for (const root of [stockHome, hostHome]) publishSidebar(root, ids);
      ledger.exec('DELETE FROM sidebar_updates');
      console.log(JSON.stringify({ sidebarUpdated: ids.length }));
    });
  } finally {
    ledger.close();
  }
}

function cleanCatalog(ids) {
  const removed = new Set();
  if (!ids.size) return removed;
  for (const file of sidebarCatalogs()) {
    assertLocalPath(stockHome, file);
    const db = openDb(file);
    try {
      if (!catalogTable(db, 'local_thread_catalog')) continue;
      transaction(db, () => {
        const remove = db.prepare("DELETE FROM local_thread_catalog WHERE host_id = 'local' AND thread_id = ?");
        const associated = ['local_thread_catalog_scan_entries', 'thread_timeline_ledger'].filter(table => catalogTable(db, table))
          .map(table => db.prepare(`DELETE FROM ${table} WHERE host_id = 'local' AND thread_id = ?`));
        let revisionChanged = false;
        for (const id of ids) {
          if (remove.run(id).changes) {
            removed.add(id);
            revisionChanged = true;
          }
          for (const statement of associated) if (statement.run(id).changes) removed.add(id);
        }
        if (revisionChanged && catalogTable(db, 'local_thread_catalog_metadata')) {
          db.exec('UPDATE local_thread_catalog_metadata SET catalog_revision = catalog_revision + 1 WHERE id = 1');
        }
      });
    } finally {
      db.close();
    }
  }
  return removed;
}

function stripSidebarReferences(state, ids) {
  const affected = new Set();
  function isReference(value) {
    if (typeof value !== 'string') return false;
    const id = value.replace(/^(?:(?:codex|local)(?::|%3A))+/i, '').toLowerCase();
    if (!ids.has(id)) return false;
    affected.add(id);
    return true;
  }
  function strip(value) {
    if (Array.isArray(value)) return value.filter(item => !isReference(item)).map(strip);
    if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (isReference(key) || isReference(child)) delete value[key];
        else value[key] = strip(child);
      }
    }
    return value;
  }
  const rootKeys = ['thread-project-assignments', 'thread-project-membership-host-ids', 'sidebar-thread-metadata',
    'sidebar-project-thread-orders', 'pinned-thread-ids', 'projectless-thread-ids'];
  const atomKeys = ['thread-descriptions-v1', 'client-thread-bindings-v1', 'app-server-pinned-thread-order-v1',
    'codex-sidebar-chat-order-v1', 'unified-sidebar-chat-order-v1'];
  const atom = state['electron-persisted-atom-state'] ?? {};
  for (const key of rootKeys) if (Object.hasOwn(state, key)) state[key] = strip(state[key]);
  for (const key of atomKeys) if (Object.hasOwn(atom, key)) atom[key] = strip(atom[key]);
  for (const migration of Object.values(state['app-server-projects-migration-by-host'] ?? {})) {
    if (Array.isArray(migration?.pendingThreadAssignmentIds)) {
      migration.pendingThreadAssignmentIds = strip(migration.pendingThreadAssignmentIds);
    }
  }
  return affected;
}

function stockThreadIds() {
  const db = openProfile(stockHome);
  try {
    return new Set([...db.prepare('SELECT id FROM state.threads').all().map(row => row.id),
      ...rolloutIndex(rolloutFiles(stockHome)).keys()]);
  } finally {
    db.close();
  }
}

async function queueExistingSidebarEntries() {
  const stock = stockThreadIds();
  const profile = openProfile(hostHome);
  const ledger = openLedger();
  try {
    const host = scan(hostHome, profile);
    const native = new Map(nativeMappings(hostData).map(mapping => [mapping.hostThreadId, mapping]));
    const possible = new Set([...host.keys(), ...native.keys()].filter(id => !stock.has(id)));
    const referenced = new Set();
    for (const file of sidebarCatalogs()) {
      for (const id of catalogReferences(file)) if (possible.has(id)) referenced.add(id);
    }
    for (const file of sidebarFiles()) {
      for (const id of stripSidebarReferences(JSON.parse(fs.readFileSync(file, 'utf8')), possible)) referenced.add(id);
    }
    const verified = [];
    const baseline = ledger.prepare('SELECT 1 FROM baseline WHERE id = ? AND stock IS NOT NULL AND host IS NOT NULL');
    const nativeIds = new Set(native.keys());
    for (const id of referenced) {
      const mapping = native.get(id);
      const entry = host.get(id);
      if (mapping ? hasNativeHistory(hostData, mapping)
        : entry?.file && baseline.get(id) && await modelPolicy(entry, nativeIds) === 'other') verified.push(id);
    }
    const enqueue = ledger.prepare('INSERT OR IGNORE INTO sidebar_cleanups VALUES (?)');
    transaction(ledger, () => { for (const id of verified) enqueue.run(id); });
    console.log(JSON.stringify({ verifiedSidebarEntries: verified.length, verifiedNativeEntries: verified.filter(id => native.has(id)).length }));
  } finally {
    profile.close();
    ledger.close();
  }
}

function desktopRunning() {
  const result = spawnSync('tasklist.exe', ['/FI', 'IMAGENAME eq ChatGPT.exe', '/FO', 'CSV', '/NH'], {
    encoding: 'utf8', windowsHide: true,
  });
  if (result.error || result.status !== 0) throw new Error('Could not verify that Codex Desktop has exited.');
  return /^"ChatGPT\.exe",/im.test(result.stdout);
}

function cleanSidebar() {
  const ledger = openLedger();
  try {
    transaction(ledger, () => {
      const pending = ledger.prepare('SELECT id FROM sidebar_cleanups').all().map(row => row.id);
      if (!pending.length) return;
      const stock = stockThreadIds();
      const ids = new Set(pending.filter(id => !stock.has(id)));
      const cleaned = cleanCatalog(ids);
      const catalogCleaned = cleaned.size;
      const edits = sidebarFiles().flatMap(file => {
        assertLocalPath(stockHome, file);
        const version = stamp(file);
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        const affected = stripSidebarReferences(data, ids);
        return affected.size ? [{ file, version, data, affected }] : [];
      });
      // The desktop process can rewrite its JSON state when exiting. SQLite has its own writer lock.
      if (edits.length && desktopRunning()) {
        console.log(JSON.stringify({ catalogCleaned, sidebarPending: new Set(edits.flatMap(edit => [...edit.affected])).size,
          waitingForDesktopExit: true }));
        return;
      }
      for (const { file, version, data, affected } of edits) {
        const staged = `${file}.codexhost-${process.pid}.tmp`;
        try {
          fs.writeFileSync(staged, JSON.stringify(data), { flag: 'wx' });
          if (desktopRunning() || stamp(file) !== version) throw new Error('Codex Desktop state changed during sidebar cleanup.');
          fs.renameSync(staged, file);
          for (const id of affected) cleaned.add(id);
        } finally {
          if (fs.existsSync(staged)) fs.unlinkSync(staged);
        }
      }
      ledger.exec('DELETE FROM sidebar_cleanups');
      console.log(JSON.stringify({ sidebarCleaned: cleaned.size, catalogCleaned }));
    });
  } finally {
    ledger.close();
  }
}

function installTask() {
  if (!fs.existsSync(path.join(hostHome, stateFile))) throw new Error('Run migrate before installing sync.');
  const action = `wscript.exe "${path.join(workspace, 'Start-CodexHost-Silent.vbs')}" --sync "${process.execPath}"`;
  const taskName = 'CodexHost Conversation Sync';
  const result = spawnSync('schtasks.exe', [
    '/Create', '/TN', taskName, '/SC', 'MINUTE', '/MO', '1', '/IT', '/TR', action, '/F',
  ], { stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error('Windows did not register the conversation sync task.');
  const settings = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    `$ErrorActionPreference = 'Stop'; $task = Get-ScheduledTask -TaskName '${taskName}'; `
    + '$task.Settings.DisallowStartIfOnBatteries = $false; $task.Settings.StopIfGoingOnBatteries = $false; '
    + '$task.Settings.StartWhenAvailable = $true; Set-ScheduledTask -InputObject $task | Out-Null',
  ], { stdio: 'inherit', windowsHide: true });
  if (settings.error) throw settings.error;
  if (settings.status !== 0) throw new Error('Sync task was installed, but its power settings could not be changed.');
  const start = spawnSync('schtasks.exe', ['/Run', '/TN', taskName], { stdio: 'inherit', windowsHide: true });
  if (start.error) throw start.error;
  if (start.status !== 0) throw new Error('Sync task was installed, but Windows did not start its first run.');
}

switch (process.argv[2]) {
  case 'migrate': migrate(); openLedger().close(); break;
  case 'projects': migrateProjects(hostHome); break;
  case 'native-history': console.log(JSON.stringify({ migratedWorkBuddy: migrateWorkBuddy(hostData) })); break;
  case 'sync': await sync(); break;
  case 'resolve': await resolveConflicts(process.argv.slice(3)); break;
  case 'plan': await prune(); break;
  case 'prune': await prune({ apply: true }); break;
  case 'sidebar': await queueExistingSidebarEntries(); cleanSidebar(); break;
  case 'install': installTask(); break;
  default: console.error('Usage: node codex-history.mjs <migrate|projects|native-history|sync|resolve|plan|prune|sidebar|install>'); process.exitCode = 1;
}
