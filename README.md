# task.geterdone

Tasks, projects, goals and a Pomodoro timer on top of Microsoft To Do, at
**https://task.geterdone.io/**.

- **Your data stays in your Microsoft account.** Tasks are Microsoft To Do tasks
  (they show up in the To Do apps). There is no server-side database and no AI.
- **Projects and goals.** Each task can belong to a project and carry a goal:
  repetitions, time, or a quantity with a unit, toward a target.
- **Results.** Log what each session produced (amount + note), optionally with
  evidence: a link, or a file. Amounts add toward the goal.
- **Attachments.** Files up to 25 MB attach natively to the To Do task. Larger
  files upload to your OneDrive app folder and are linked to the task.
- **Pomodoro.** 25/5/15 with a long break every 4 (all adjustable), tied to the
  selected task. Finished focus sessions log their minutes toward a time goal.
  Browser notification and a chime at the end of each phase.
- **Demo mode** keeps everything in the browser, for trying it without signing in.

## Where things are stored

| What | Where |
| --- | --- |
| Task, title, description, due date, repeat, importance, completion | Microsoft To Do task |
| Project, goal type, target, unit, cached progress | Open extension `io.geterdone.task` on the To Do task |
| Result log (amount, note, evidence) | `Apps/<app>/task-geterdone/results/<sha256(taskId)>.json` in OneDrive |
| Project names and colours | `Apps/<app>/task-geterdone/projects.json` in OneDrive |
| Files ≤ 25 MB | To Do task attachments |
| Files > 25 MB | `Apps/<app>/task-geterdone/evidence/` in OneDrive, linked as a To Do linked resource |
| Pomodoro settings and timer state | `localStorage` in the browser |

The result log lives in OneDrive rather than in the extension because it grows
without bound and open extensions are meant for small property bags; the
extension keeps a cached total so list views never need to read the log.

## Sign-in

Authorization code + PKCE against `https://login.microsoftonline.com/common`,
hand-written in [`site/js/auth.js`](site/js/auth.js) (no auth library, no CDN).
It uses the same Entra app registration as learn.geterdone.io
(`5eb7789c-2954-4d7d-bf0a-39f9ae5cc90f`, all Microsoft account types). That
registration needs the SPA redirect URI `https://task.geterdone.io/oauth2/spa/callback/`.
Scopes: `openid profile offline_access User.Read Tasks.ReadWrite Files.ReadWrite.AppFolder`.

## Layout

```
site/                 the document root, served as-is (no build step)
  index.html          the app shell
  app.css
  js/app.js           UI
  js/auth.js          PKCE sign-in
  js/backend.js       Graph backend + local demo backend
  js/model.js         To Do <-> app mapping (pure)
  js/goals.js         goals and results (pure)
  js/pomodoro.js      timer state machine (pure)
  oauth2/spa/callback/ the redirect target
deploy/Caddyfile      in-container Caddy: headers, CSP, /healthz, /release.txt
Containerfile.release caddy:2.10.0-alpine pinned by digest, runs as 1000:1000 on :8080
tests/                node --test unit tests for the pure modules
```

## Develop

```bash
npm test
podman build -f Containerfile.release -t task-geterdone:local .
podman run --rm -p 127.0.0.1:8099:8080 -v ./site:/srv:ro,Z task-geterdone:local
```

Sign-in only works on origins registered as redirect URIs; use the demo locally.

## Release

Every push to `main` runs CI, builds the image and publishes it to
`ghcr.io/dmedellin/task-geterdone` (tagged `sha-<commit>` and `main`), then the
`deploy-production` job runs on the production host's self-hosted runner and
calls the root-owned `platform-deploy-static` wrapper, exactly like
learn-geterdone. The deploy job is gated on the repository variable
`DEPLOY_ENABLED=true`. Host-side registration lives in `dmedellin/platform-ops`
(see [`deploy/registry-entry.PROPOSED.yaml`](deploy/registry-entry.PROPOSED.yaml)).
