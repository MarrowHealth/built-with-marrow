# Built with Marrow

Things people build with [Marrow Health](https://marrowhealthapp.com)'s connections: dashboards, automations, AI agents and anything else that runs on your own health data.

Marrow is an iPhone and Apple Watch app. Its Export tab sends your Apple Health data, food diary, strength log, sleep, symptoms and mood to the tools you choose: an AI assistant over MCP, an automation that posts JSON on a schedule, or a file. Every project here starts from one of those connections.

The same list is on the site: **[marrowhealthapp.com/built-with](https://marrowhealthapp.com/built-with)**.

## Projects

| Project | What it does | Connections | By |
|---|---|---|---|
| [Body Ops](projects/body-ops) | Every signal from your phone, watch and logs on one Grafana dashboard: a year of heart rate by the hour, sleep stages, steps, food, lifting and more. Docker Compose, about fifteen minutes to set up, with a demo mode to try it first. | InfluxDB, Grafana | Marrow Health |

The full list, with the details the site uses, is in [showcase.json](showcase.json).

## Add yours

Built something with a Marrow connection? Two ways in:

1. **[Fill in the submission form](https://github.com/MarrowHealth/built-with-marrow/issues/new?template=submit-project.yml)**. No fork needed.
2. **Open a pull request** that adds an entry to [showcase.json](showcase.json) (and, if you like, your code under `projects/`). See [CONTRIBUTING.md](CONTRIBUTING.md).

What we look for:

- **It uses Marrow.** Any connection counts: Cloud MCP, the on-phone or self-hosted MCP server, an automation, or an export file.
- **Someone else can rebuild it.** Public source under an [OSI license](https://opensource.org/licenses), or a write-up or video detailed enough to follow.
- **It is safe to share.** No API keys, tokens or passwords in the code. Screenshots show only data you are happy to make public, and never someone else's.
- **It works.** We try what we can. Projects that stop working are marked or removed.

We review submissions within a week. Accepted projects appear here and on the site, credited to you and linked to your code.

## This repository

```
showcase.json          every listed project (the site builds its page from this)
showcase/images/       one picture per project
projects/<id>/         full source for projects that live here
.github/               the submission form and the check that runs on every change
```

Code in this repository is MIT licensed (see [LICENSE](LICENSE)). Projects listed from elsewhere keep their own licenses.

Questions: [support@marrowhealthapp.com](mailto:support@marrowhealthapp.com).
