# Adding a project

The easiest way is the [submission form](https://github.com/MarrowHealth/built-with-marrow/issues/new?template=submit-project.yml). We turn it into an entry for you.

If you would rather open a pull request, add one object to the `projects` list in [showcase.json](showcase.json) and its picture to `showcase/images/`. A check runs on every pull request and tells you if anything is missing.

## An entry

```json
{
  "id": "my-project",
  "title": "My Project",
  "summary": "One sentence, under 160 characters, on what it does.",
  "description": "A short paragraph: what it shows or does, and what you used to build it.",
  "author": {"name": "Your name", "url": "https://github.com/you"},
  "connections": ["claude", "n8n"],
  "data": ["metrics", "workouts"],
  "links": {"code": "https://github.com/you/my-project", "post": "https://..."},
  "image": "showcase/images/my-project.webp",
  "license": "MIT",
  "added": "2026-10-24"
}
```

- **id**: lowercase letters, digits and hyphens. Also the image name.
- **connections**: the Marrow connections it uses, by their id on [marrowhealthapp.com/connections](https://marrowhealthapp.com/connections): `claude`, `claude-desktop`, `claude-code`, `chatgpt`, `codex`, `gemini`, `gemini-cli`, `grok`, `lechat`, `perplexity`, `notion`, `cursor`, `vscode`, `zed`, `cline`, `openclaw`, `hermes`, `n8n`, `zapier`, `make`, `home-assistant`, `sheets`, `grafana-assistant`, `grafana`, `influxdb`, `strava`, `custom`.
- **data**: what it reads, from `metrics` (daily totals), `samples` (raw readings), `workouts`, `strength`, `nutrition`, `symptoms` (symptoms and mood), `mcp` (an AI reading through MCP tools), `writes` (the AI logs things back).
- **links**: `code` (required unless you give `post`), and optionally `post` (a write-up or video) and `demo`.
- **image**: 1600 by 900 or close to it, PNG, JPG or WebP, under 1 MB. Show only data you are happy to make public.
- **license**: an SPDX id such as `MIT` or `Apache-2.0`, or `none` for a write-up without code.

## Code in this repository

Projects can live under `projects/<id>/` when they are small and self-contained. Each needs a README that gets someone from zero to working, no secrets in any file (ship a `.env.example` instead), and an MIT license (this repository's).

## Review

We read every submission within a week, try it when we can, and may suggest changes. We list projects at our discretion, and we remove ones that stop working or that show data their author did not mean to share.
