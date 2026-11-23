import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { httpRequest } from '../utils/http.js';
import { requireGraphTokenAsync } from '../utils/auth-guards.js';
import { invalidateAccessToken } from '../auth/token-extractor.js';
import { ok, err } from '../types/result.js';
import { ErrorCode, createError } from '../types/errors.js';
import { downloadFile } from './graph-files-api.js';

vi.mock('../utils/http.js', () => ({ httpRequest: vi.fn() }));
vi.mock('../utils/auth-guards.js', () => ({ requireGraphTokenAsync: vi.fn() }));
vi.mock('../auth/token-extractor.js', () => ({ invalidateAccessToken: vi.fn() }));
// realpath is wrapped (not replaced) so tests can assert it is never reached
// for paths that must be rejected before any filesystem touch.
vi.mock('node:fs/promises', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs/promises')>();
  return { ...orig, realpath: vi.fn(orig.realpath) };
});

const FILE_URL = 'https://graph.microsoft.com/v1.0/drives/b!abc_DEF-123/items/01VO3D63DYJHLB2KJCVFD3YH77DMC5RIEJ';
const DOWNLOAD_URL = 'https://school.sharepoint.com/sites/x/_layouts/15/download.aspx?UniqueId=1&tempauth=secret';
const BYTES = Buffer.from('PK\u0003\u0004 pretend pptx bytes');

const mockHttp = vi.mocked(httpRequest);
const realpathMock = vi.mocked(realpath);
const fetchMock = vi.fn();
let dir: string;

function item(overrides: Record<string, unknown> = {}) {
  return ok({ status: 200, headers: new Headers(), data: {
    name: 'Lesson.pptx', size: BYTES.length, file: { mimeType: 'application/vnd.ms-powerpoint' },
    currentUserRole: { blocksDownload: false }, '@microsoft.graph.downloadUrl': DOWNLOAD_URL, ...overrides,
  } });
}

beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(requireGraphTokenAsync).mockResolvedValue(ok('graph-token'));
  fetchMock.mockImplementation(async () => new Response(BYTES, { status: 200, headers: { 'content-type': 'application/octet-stream' } }));
  vi.stubGlobal('fetch', fetchMock);
  dir = await mkdtemp(join(tmpdir(), 'graph-files-'));
  process.env.TEAMS_MCP_DOWNLOAD_DIR = dir;
});

afterEach(async () => {
  vi.unstubAllGlobals();
  delete process.env.TEAMS_MCP_DOWNLOAD_DIR;
  await rm(dir, { recursive: true, force: true });
});

describe('downloadFile', () => {
  it('streams the file to disk with owner-only permissions and reports its hash', async () => {
    mockHttp.mockResolvedValue(item());
    const out = join(dir, 'lesson.pptx');

    const result = await downloadFile(FILE_URL, out);

    expect(result).toEqual(ok({
      // The returned path is the real path (8.3/casing resolved) + file name.
      name: 'Lesson.pptx', outputPath: join(await realpath(dir), 'lesson.pptx'), size: BYTES.length, contentType: 'application/octet-stream',
      sha256: createHash('sha256').update(BYTES).digest('hex'),
    }));
    expect(await readFile(out)).toEqual(BYTES);
    // Windows has no POSIX mode bits; Node reports 0o666 for files there.
    expect((await stat(out)).mode & 0o777).toBe(process.platform === 'win32' ? 0o666 : 0o600);
    const [metaUrl, metaOpts] = mockHttp.mock.calls[0];
    expect(new URL(metaUrl as string).searchParams.get('$select')).toContain('content.downloadUrl');
    expect((metaOpts as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer graph-token');
    // The pre-authenticated link gets no bearer token and no redirects.
    const [dlUrl, dlOpts] = fetchMock.mock.calls[0];
    expect(dlUrl).toBe(DOWNLOAD_URL);
    expect(dlOpts).toMatchObject({ redirect: 'error' });
    expect((dlOpts as RequestInit).headers).toBeUndefined();
  });

  it('resolves a SharePoint/OneDrive web URL through the Graph shares API', async () => {
    mockHttp.mockResolvedValue(item());
    const webUrl = 'https://school-my.sharepoint.com/personal/pupil/Documents/Microsoft Teams Chat Files/Essay.docx';
    const out = join(dir, 'essay.docx');

    expect(await downloadFile(webUrl, out)).toMatchObject({ ok: true, value: { size: BYTES.length } });

    const metaUrl = new URL(mockHttp.mock.calls[0][0] as string);
    // The SharePoint URL only ever travels to Graph, encoded as a share ID.
    expect(metaUrl.origin).toBe('https://graph.microsoft.com');
    expect(metaUrl.pathname).toBe(`/v1.0/shares/u!${Buffer.from(webUrl).toString('base64url')}/driveItem`);
    expect(await readFile(out)).toEqual(BYTES);
  });

  it('accepts Doc.aspx viewer links, which Graph resolves to the underlying file', async () => {
    mockHttp.mockResolvedValue(item());
    const viewer = 'https://school.sharepoint.com/sites/Class/_layouts/15/Doc.aspx?sourcedoc=%7B1D%7D&file=L4.pptx&action=edit';
    expect(await downloadFile(viewer, join(dir, 'l4.pptx'))).toMatchObject({ ok: true });
    expect(mockHttp.mock.calls[0][0]).toContain(`/shares/u!${Buffer.from(viewer).toString('base64url')}/driveItem`);
  });

  it('reports an unresolvable SharePoint URL as not found', async () => {
    mockHttp.mockResolvedValue(err(createError(ErrorCode.NOT_FOUND, 'HTTP 404')));
    expect(await downloadFile('https://school.sharepoint.com/sites/x/gone.docx', join(dir, 'x'))).toMatchObject({ ok: false, error: { code: ErrorCode.NOT_FOUND } });
  });

  it.each([
    'https://evil.example/v1.0/drives/b!abc/items/01X',
    'https://graph.microsoft.com/v1.0/me/drive/items/01X',
    `${FILE_URL}?$select=x`,
    `${FILE_URL}/../../me`,
    'http://school.sharepoint.com/sites/x/file.docx',
    'https://school.sharepoint.com.evil.example/file.docx',
    'https://user:pass@school.sharepoint.com/file.docx',
    'https://school.sharepoint.com:8443/file.docx',
    'https://forms.office.com/Pages/ResponsePage.aspx?id=x',
    'not a url',
  ])('rejects anything but a Graph drive item or SharePoint URL before using the token: %s', async url => {
    expect(await downloadFile(url, join(dir, 'x'))).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    expect(requireGraphTokenAsync).not.toHaveBeenCalled();
  });

  it('rejects an absolute output path outside the download root', async () => {
    const outside = join(tmpdir(), 'outside-root.pptx');
    expect(await downloadFile(FILE_URL, outside)).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    expect(requireGraphTokenAsync).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a path that escapes the root through ".." without touching the filesystem', async () => {
    for (const out of [join(dir, '..', 'escape.pptx'), join('..', 'escape.pptx'), 'sub/../../escape.pptx']) {
      expect(await downloadFile(FILE_URL, out)).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    }
    // The lexical check fires before any realpath/mkdir syscall.
    expect(realpathMock).not.toHaveBeenCalled();
    expect(requireGraphTokenAsync).not.toHaveBeenCalled();
  });

  it('rejects a UNC output path before any filesystem touch', async () => {
    expect(await downloadFile(FILE_URL, '\\\\evil.example\\share\\loot.pptx'))
      .toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    // realpath on a UNC path would hit the network (SMB/NTLM).
    expect(realpathMock).not.toHaveBeenCalled();
    expect(requireGraphTokenAsync).not.toHaveBeenCalled();
  });

  it('resolves a relative name inside the download root', async () => {
    mockHttp.mockResolvedValue(item());
    const result = await downloadFile(FILE_URL, 'relative.pptx');
    // The returned path is the real path: resolved parent + file name.
    expect(result).toMatchObject({ ok: true, value: { outputPath: join(await realpath(dir), 'relative.pptx') } });
    expect(await readFile(join(dir, 'relative.pptx'))).toEqual(BYTES);
  });

  it('creates missing subdirectories inside the download root', async () => {
    mockHttp.mockResolvedValue(item());
    const result = await downloadFile(FILE_URL, 'reports/2026/x.pptx');
    const parentReal = await realpath(join(dir, 'reports', '2026'));
    expect(result).toMatchObject({ ok: true, value: { outputPath: join(parentReal, 'x.pptx') } });
    expect(await readFile(join(dir, 'reports', '2026', 'x.pptx'))).toEqual(BYTES);
  });

  it('errors when TEAMS_MCP_DOWNLOAD_DIR is not absolute', async () => {
    process.env.TEAMS_MCP_DOWNLOAD_DIR = 'not-absolute';
    expect(await downloadFile(FILE_URL, 'x.pptx')).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    expect(requireGraphTokenAsync).not.toHaveBeenCalled();
  });

  (process.platform === 'win32' ? it : it.skip)('accepts a differently-cased path inside the root and rejects ADS names', async () => {
    mockHttp.mockResolvedValue(item());
    const mixedCase = join(dir, 'MiXeD.pptx').split('').map((c, i) => (i % 2 ? c.toUpperCase() : c.toLowerCase())).join('');
    expect(await downloadFile(FILE_URL, mixedCase)).toMatchObject({ ok: true });

    expect(await downloadFile(FILE_URL, 'a.txt:stream')).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('never overwrites an existing file', async () => {
    mockHttp.mockResolvedValue(item());
    const out = join(dir, 'existing.pptx');
    await writeFile(out, 'keep me');
    expect(await downloadFile(FILE_URL, out)).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
    expect(await readFile(out, 'utf8')).toBe('keep me');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('respects an owner download block without creating a file', async () => {
    mockHttp.mockResolvedValue(item({ currentUserRole: { blocksDownload: true } }));
    const out = join(dir, 'blocked.pptx');
    expect(await downloadFile(FILE_URL, out)).toMatchObject({ ok: false, error: { code: ErrorCode.ACCESS_DENIED } });
    expect(existsSync(out)).toBe(false);
  });

  it.each(['https://evil.example/file', 'http://school.sharepoint.com/file', undefined])('refuses a non-SharePoint download link: %s', async link => {
    mockHttp.mockResolvedValue(item({ '@microsoft.graph.downloadUrl': link }));
    expect(await downloadFile(FILE_URL, join(dir, 'x'))).toMatchObject({ ok: false, error: { code: ErrorCode.API_ERROR } });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects folders', async () => {
    mockHttp.mockResolvedValue(item({ file: undefined }));
    expect(await downloadFile(FILE_URL, join(dir, 'x'))).toMatchObject({ ok: false, error: { code: ErrorCode.INVALID_INPUT } });
  });

  it('removes a truncated download', async () => {
    mockHttp.mockResolvedValue(item({ size: BYTES.length + 10 }));
    const out = join(dir, 'short.pptx');
    expect(await downloadFile(FILE_URL, out)).toMatchObject({ ok: false, error: { code: ErrorCode.API_ERROR } });
    expect(existsSync(out)).toBe(false);
  });

  it('removes the partial file when the stream fails', async () => {
    mockHttp.mockResolvedValue(item());
    fetchMock.mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array([1, 2, 3])); controller.error(new Error('connection reset')); },
    })));
    const out = join(dir, 'broken.pptx');
    expect(await downloadFile(FILE_URL, out)).toMatchObject({ ok: false, error: { code: ErrorCode.NETWORK_ERROR } });
    expect(existsSync(out)).toBe(false);
  });

  it('discards a rejected Graph token without triggering Teams re-login', async () => {
    mockHttp.mockResolvedValue(err(createError(ErrorCode.AUTH_EXPIRED, 'HTTP 401')));
    expect(await downloadFile(FILE_URL, join(dir, 'x'))).toMatchObject({ ok: false, error: { code: ErrorCode.API_ERROR, retryable: true } });
    expect(invalidateAccessToken).toHaveBeenCalledWith('graph-token');
  });

  it('reports a 403 as access denied, not an auth error', async () => {
    mockHttp.mockResolvedValue(err(createError(ErrorCode.AUTH_REQUIRED, 'HTTP 403')));
    expect(await downloadFile(FILE_URL, join(dir, 'x'))).toMatchObject({ ok: false, error: { code: ErrorCode.ACCESS_DENIED } });
  });

  it('passes through an unavailable Graph token unchanged', async () => {
    const unavailable = err(createError(ErrorCode.AUTH_INTERACTION_REQUIRED, 'Microsoft Graph could not be authorized'));
    vi.mocked(requireGraphTokenAsync).mockResolvedValue(unavailable);
    expect(await downloadFile(FILE_URL, join(dir, 'x'))).toEqual(unavailable);
    expect(mockHttp).not.toHaveBeenCalled();
  });
});
