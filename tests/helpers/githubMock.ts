import { vi } from "vitest";

/**
 * In-memory stand-in for the GitHub contents API: PUT/GET with sha checks,
 * ETags and If-None-Match (304). Shared by the stateStore and runs tests so
 * the store interface stays honest.
 */
export interface MockFile {
  content: string;
  sha: string;
  etag: string;
}

export interface GitHubMock {
  files: Map<string, MockFile>;
  fetchMock: ReturnType<typeof vi.fn>;
  failNextPut: (status: number) => void;
}

export function installGitHubMock(): GitHubMock {
  const files = new Map<string, MockFile>();
  let shaSeq = 0;
  let etagSeq = 0;
  let failPutWith: number | null = null;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const marker = "/contents/";
    if (!url.includes(marker)) {
      // Squash maintenance endpoints — nothing to do in tests.
      return Response.json({ object: { sha: "head" }, sha: "head", tree: { sha: "tree" } });
    }
    const path = decodeURIComponent(url.slice(url.indexOf(marker) + marker.length).split("?")[0]);
    const headers = new Headers(init?.headers);

    if (method === "GET") {
      const file = files.get(path);
      if (!file) return new Response("Not Found", { status: 404 });
      if (headers.get("If-None-Match") === file.etag) {
        return new Response(null, { status: 304 });
      }
      return Response.json(
        { sha: file.sha, content: file.content, encoding: "base64" },
        { headers: { etag: file.etag } },
      );
    }

    if (method === "PUT") {
      if (failPutWith !== null) {
        const status = failPutWith;
        failPutWith = null;
        return new Response("boom", { status });
      }
      const body = JSON.parse(String(init?.body)) as { content: string; sha?: string };
      const existing = files.get(path);
      if (existing && body.sha !== existing.sha) {
        return new Response("sha mismatch", { status: 409 });
      }
      if (!existing && body.sha) {
        return new Response("sha unknown", { status: 422 });
      }
      const file: MockFile = {
        content: body.content,
        sha: `sha-${++shaSeq}`,
        etag: `etag-${etagSeq++}`,
      };
      files.set(path, file);
      return Response.json(
        { sha: file.sha, content: file.content, encoding: "base64" },
        { headers: { etag: file.etag } },
      );
    }

    return new Response("method not allowed", { status: 405 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return {
    files,
    fetchMock,
    failNextPut: (status: number) => {
      failPutWith = status;
    },
  };
}

export function storedJson(files: Map<string, MockFile>, path: string): unknown {
  const file = files.get(path);
  if (!file) throw new Error(`expected ${path} to exist`);
  return JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
}
