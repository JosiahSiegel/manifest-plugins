import * as childProcess from 'child_process';
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';

export type ManifestSource = {
  readonly kind: 'url' | 'dir' | 'fork';
  readonly ref?: string;
  readonly url?: string;
  readonly path: string;
  readonly commit: string;
};

export type GitRunOptions = {
  readonly cwd?: string;
};

export type GitRunner = (
  args: readonly string[],
  options?: GitRunOptions,
) => Promise<string>;

export type GitCloneRequest = {
  readonly url: string;
  readonly ref?: string;
  readonly targetDir: string;
};

export type GitCloneRunner = (request: GitCloneRequest) => Promise<void>;

export type SourceResolverEnv = Readonly<Record<string, string | undefined>>;

export type SpawnSyncLike = (
  command: string,
  args: readonly string[],
  options: childProcess.SpawnSyncOptionsWithStringEncoding,
) => childProcess.SpawnSyncReturns<string>;

export type ResolveManifestSourceOptions = {
  readonly manifestUrl?: string;
  readonly manifestRef?: string;
  readonly manifestDir?: string;
  readonly manifestFork?: string;
  readonly env?: SourceResolverEnv;
  readonly runGit?: GitRunner;
  readonly runGitClone?: GitCloneRunner;
  readonly createTempDir?: () => Promise<string>;
  readonly spawnSync?: SpawnSyncLike;
};

export const OFFICIAL_MANIFEST_URL = 'https://github.com/mnfst/manifest.git';

class ManifestSourceError extends Error {
  readonly name = 'ManifestSourceError';
}

function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed === '' ? undefined : trimmed;
}

function envValue(
  env: SourceResolverEnv,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = text(env[name]);
    if (value !== undefined) return value;
  }
  return undefined;
}

function parseHttpUrl(url: string): URL {
  if (!URL.canParse(url)) {
    throw new ManifestSourceError('manifest URL must be an http(s) URL');
  }
  return new URL(url);
}

function assertValidUrl(url: string): void {
  const parsed = parseHttpUrl(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new ManifestSourceError('manifest URL must be an http(s) URL');
  }
}

function forkUrl(fork: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(fork)) {
    throw new ManifestSourceError('manifest fork must look like <owner>/<repo>');
  }
  return `https://github.com/${fork}.git`;
}

function cloneRef(ref: string | undefined, commit: string): string {
  return ref ?? commit;
}

async function defaultCreateTempDir(): Promise<string> {
  return fs.mkdtemp(join(tmpdir(), 'manifest-plugins-manifest-'));
}

function createGitRunner(spawn: SpawnSyncLike): GitRunner {
  return async (args: readonly string[], options: GitRunOptions = {}) => {
    const result = spawn('git', args, {
      cwd: options.cwd,
      encoding: 'utf-8',
    });
    if (result.status !== 0) {
      const stderr = result.stderr.trim() || `git ${args.join(' ')} failed`;
      throw new ManifestSourceError(stderr);
    }
    return result.stdout.trim();
  };
}

function createGitCloneRunner(runGit: GitRunner): GitCloneRunner {
  return async (request: GitCloneRequest) => {
    const args = ['clone', '--depth=1'];
    if (request.ref !== undefined) {
      args.push('--branch', request.ref);
    }
    args.push(request.url, request.targetDir);
    await runGit(args);
  };
}

type StatFn = (path: string) => Promise<unknown>;

const defaultStat: StatFn = (path) => fs.stat(path);

async function exists(path: string, stat?: StatFn): Promise<boolean> {
  const probe = stat ?? defaultStat;
  try {
    await probe(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function errorCode(error: unknown): unknown {
  if (typeof error !== 'object' || error === null) return undefined;
  return Reflect.get(error, 'code');
}

async function isGitRepo(path: string, runGit: GitRunner): Promise<boolean> {
  try {
    return (await runGit(['rev-parse', '--is-inside-work-tree'], { cwd: path })) === 'true';
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

async function listSnapshotFiles(root: string, relativeDir = ''): Promise<readonly string[]> {
  const currentDir = join(root, relativeDir);
  const entries = await fs.readdir(currentDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const relativePath = join(relativeDir, entry.name).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      files.push(...(await listSnapshotFiles(root, relativePath)));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files.sort();
}

async function contentDigest(root: string): Promise<string> {
  const hash = createHash('sha256');
  const files = await listSnapshotFiles(root);
  for (const file of files) {
    hash.update(file);
    hash.update('\0');
    hash.update(await fs.readFile(join(root, file)));
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

type SourceChoice =
  | { readonly kind: 'dir'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'fork'; readonly fork: string; readonly url: string };

function chooseSource(opts: ResolveManifestSourceOptions): SourceChoice {
  const env = opts.env ?? process.env;
  const manifestDir = text(opts.manifestDir) ?? envValue(env, ['MANIFEST_DIR', 'MANIFEST_CHECKOUT']);
  const manifestUrl = text(opts.manifestUrl) ?? envValue(env, ['MANIFEST_URL']);
  const manifestFork = text(opts.manifestFork) ?? envValue(env, ['MANIFEST_FORK']);
  const selected = [manifestDir, manifestUrl, manifestFork].filter(
    (value) => value !== undefined,
  );
  if (selected.length > 1) {
    throw new ManifestSourceError(
      'choose only one Manifest source: --manifest-dir, --manifest-url, or --manifest-fork',
    );
  }
  if (manifestDir !== undefined) return { kind: 'dir', path: manifestDir };
  if (manifestFork !== undefined) {
    return { kind: 'fork', fork: manifestFork, url: forkUrl(manifestFork) };
  }
  return { kind: 'url', url: manifestUrl ?? OFFICIAL_MANIFEST_URL };
}

function chooseRef(opts: ResolveManifestSourceOptions): string | undefined {
  const ref = text(opts.manifestRef) ?? envValue(opts.env ?? process.env, ['MANIFEST_REF', 'MANIFEST_OFFICIAL_REF']);
  if (opts.manifestRef !== undefined && ref === undefined) {
    throw new ManifestSourceError('manifest ref cannot be empty');
  }
  return ref;
}

export async function existsWithStat(
  path: string,
  stat?: StatFn,
): Promise<boolean> {
  return exists(path, stat);
}

async function resolveLocalDir(
  path: string,
  runGit: GitRunner,
): Promise<ManifestSource> {
  const absolutePath = resolve(path);
  if (!(await exists(absolutePath, defaultStat))) {
    throw new ManifestSourceError(`manifest dir does not exist: ${absolutePath}`);
  }
  const commit = (await isGitRepo(absolutePath, runGit))
    ? await runGit(['rev-parse', 'HEAD'], { cwd: absolutePath })
    : await contentDigest(absolutePath);
  return { kind: 'dir', path: absolutePath, commit };
}

async function resolveClone(
  source: Extract<SourceChoice, { readonly kind: 'url' | 'fork' }>,
  ref: string | undefined,
  createTempDir: () => Promise<string>,
  runGit: GitRunner,
  runGitClone: GitCloneRunner,
): Promise<ManifestSource> {
  assertValidUrl(source.url);
  const path = await createTempDir();
  await runGitClone({ url: source.url, ref, targetDir: path });
  const commit = await runGit(['rev-parse', 'HEAD'], { cwd: path });
  return {
    kind: source.kind,
    url: source.url,
    path,
    commit,
    ref: cloneRef(ref, commit),
  };
}

export async function resolveManifestSource(
  opts?: ResolveManifestSourceOptions,
): Promise<ManifestSource> {
  const effective = opts ?? {};
  const runGit = effective.runGit ?? createGitRunner(effective.spawnSync ?? childProcess.spawnSync);
  const runGitClone = effective.runGitClone ?? createGitCloneRunner(runGit);
  const createTempDir = effective.createTempDir ?? defaultCreateTempDir;
  const source = chooseSource(effective);
  const ref = chooseRef(effective);
  switch (source.kind) {
    case 'dir':
      return resolveLocalDir(source.path, runGit);
    case 'url':
    case 'fork':
      return resolveClone(source, ref, createTempDir, runGit, runGitClone);
  }
}
