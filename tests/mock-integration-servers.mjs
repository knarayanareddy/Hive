/**
 * Mock GitHub + mock Slack as a SEPARATE PROCESS — the kernel's effect path is
 * synchronous (execFileSync curl), so an in-process mock server would deadlock
 * the event loop. This file is spawned by tests/integrations.spec.ts.
 *
 * On readiness it prints a single line:
 *   PORTS {"github":<port>,"slack":<port>}
 * Both servers expose GET /__state returning their counters as JSON.
 * Runs until SIGTERM.
 */
import http from "node:http";

const ghState = {
  pullsPost: 0,
  mergePut: 0,
  commentsPost: 0,
  refsPost: 0,
  prs: [],
  comments: [],
  branches: new Set(),
  merged: new Set(),
  nextPr: 4413,
};

const slackState = { webhookPosts: [] };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}
const readBody = (req) =>
  new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });

const github = http.createServer(async (req, res) => {
  const u = new URL(req.url ?? "/", "http://127.0.0.1");
  const p = u.pathname;
  if (req.method === "GET" && p === "/__state") {
    return json(res, 200, {
      pullsPost: ghState.pullsPost,
      mergePut: ghState.mergePut,
      commentsPost: ghState.commentsPost,
      refsPost: ghState.refsPost,
      prs: ghState.prs,
      branches: [...ghState.branches],
      merged: [...ghState.merged],
    });
  }
  const body = await readBody(req);

  if (req.method === "GET" && p === "/repos/acme/www/pulls") {
    const head = u.searchParams.get("head") ?? "";
    const branch = head.split(":")[1] ?? head;
    return json(res, 200, ghState.prs.filter((pr) => pr.head.ref === branch));
  }
  if (req.method === "POST" && p === "/repos/acme/www/pulls") {
    ghState.pullsPost += 1;
    const parsed = JSON.parse(body);
    const pr = {
      number: ghState.nextPr++,
      html_url: `http://mock.local/acme/www/pull/${ghState.nextPr - 1}`,
      state: "open",
      merged: false,
      merge_commit_sha: `merge-${ghState.nextPr - 1}`,
      title: parsed.title,
      head: { ref: parsed.head, sha: "deadbeef1234" },
      base: { ref: parsed.base },
      body: parsed.body,
    };
    ghState.prs.push(pr);
    return json(res, 201, pr);
  }
  const prRead = p.match(/^\/repos\/acme\/www\/pulls\/(\d+)$/);
  if (req.method === "GET" && prRead) {
    const n = Number(prRead[1]);
    const pr = ghState.prs.find((x) => x.number === n);
    if (!pr) return json(res, 404, { message: "not found" });
    return json(res, 200, { ...pr, merged: ghState.merged.has(n) });
  }
  const prMerge = p.match(/^\/repos\/acme\/www\/pulls\/(\d+)\/merge$/);
  if (req.method === "PUT" && prMerge) {
    ghState.mergePut += 1;
    const n = Number(prMerge[1]);
    ghState.merged.add(n);
    const pr = ghState.prs.find((x) => x.number === n);
    if (pr) {
      pr.merged = true;
      pr.merge_commit_sha = `merge-${n}-squashed`;
    }
    return json(res, 200, { merged: true, sha: `merge-${n}-squashed` });
  }
  if (req.method === "GET" && p === "/repos/acme/www/git/ref/heads/main") {
    return json(res, 200, { ref: "refs/heads/main", object: { sha: "base00cafe" } });
  }
  const branchRef = p.match(/^\/repos\/acme\/www\/git\/ref\/heads\/(.+)$/);
  if (req.method === "GET" && branchRef) {
    const branch = decodeURIComponent(branchRef[1]);
    if (ghState.branches.has(branch)) {
      return json(res, 200, { ref: `refs/heads/${branch}`, object: { sha: "base00cafe" } });
    }
    return json(res, 404, { message: "Not Found" });
  }
  if (req.method === "POST" && p === "/repos/acme/www/git/refs") {
    ghState.refsPost += 1;
    const parsed = JSON.parse(body);
    const branch = parsed.ref.replace("refs/heads/", "");
    if (ghState.branches.has(branch)) {
      return json(res, 422, { message: "Reference already exists" });
    }
    ghState.branches.add(branch);
    return json(res, 201, { ref: parsed.ref, object: { sha: parsed.sha } });
  }
  const commentsList = p.match(/^\/repos\/acme\/www\/issues\/(\d+)\/comments$/);
  if (req.method === "GET" && commentsList) return json(res, 200, ghState.comments);
  if (req.method === "POST" && commentsList) {
    ghState.commentsPost += 1;
    const parsed = JSON.parse(body);
    const comment = { id: 1000 + ghState.comments.length, body: parsed.body };
    ghState.comments.push(comment);
    return json(res, 201, comment);
  }
  json(res, 404, { message: `mock github: unhandled ${req.method} ${p}` });
});

const slack = http.createServer(async (req, res) => {
  if (req.method === "GET" && req.url === "/__state") {
    return json(res, 200, slackState);
  }
  if (req.method === "POST" && req.url === "/hook") {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      slackState.webhookPosts.push(data);
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

function listen(server) {
  return new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

const [githubPort, slackPort] = await Promise.all([listen(github), listen(slack)]);
console.log(`PORTS ${JSON.stringify({ github: githubPort, slack: slackPort })}`);
setInterval(() => {}, 1 << 30);
