import { readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

function processFile(path) {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) return null;
    throw error;
  }
}
export function isOpenDLEProcess(args, cwd, root) {
  if (!/^node(?:js)?(?:\.exe)?$/.test(basename(args[0] || ''))) return false;
  return args.slice(1).some(arg => !arg.startsWith('-') && resolve(cwd, arg) === resolve(root, 'server/index.js'));
}
export function listenerPID(port, root) {
  if (process.platform !== 'linux') throw new Error('Automatic restart of legacy servers requires Linux. Stop the old server manually before launching on this platform.');
  const inodes = new Set();
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    for (const line of (processFile(table) || '').trim().split('\n').slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields[3] === '0A' && Number.parseInt(fields[1].split(':').at(-1), 16) === port) inodes.add(`socket:[${fields[9]}]`);
    }
  }
  const owners = new Set();
  for (const entry of readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    const base = `/proc/${entry}`, command = processFile(`${base}/cmdline`);
    if (!command) continue;
    let cwd, descriptors;
    try { cwd = readlinkSync(`${base}/cwd`); descriptors = readdirSync(`${base}/fd`); }
    catch (error) {
      if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) continue;
      throw error;
    }
    for (const fd of descriptors) {
      let target;
      try { target = readlinkSync(`${base}/fd/${fd}`); }
      catch (error) {
        if (['ENOENT', 'EACCES', 'EPERM', 'ESRCH'].includes(error.code)) continue;
        throw error;
      }
      if (inodes.has(target)) {
        if (!isOpenDLEProcess(command.split('\0').filter(Boolean), cwd, root)) throw new Error(`Port ${port} belongs to an unrelated process; refusing to stop it.`);
        owners.add(Number(entry));
      }
    }
  }
  if (owners.size !== 1) throw new Error(`Cannot uniquely identify the OpenDLE process on port ${port}; refusing to stop anything.`);
  return [...owners][0];
}
export async function restartExisting(port, root) {
  const pid = listenerPID(port, root);
  process.kill(pid, 'SIGTERM');
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(pid, 0); }
    catch (error) { if (error.code === 'ESRCH') return; throw error; }
    await delay(100);
  }
  throw new Error(`OpenDLE process ${pid} did not stop within 10 seconds. No forced termination was attempted.`);
}
