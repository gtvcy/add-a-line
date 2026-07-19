# Contributing

## Before You Start

- Keep changes focused on a user-visible problem or a concrete reliability issue.
- Preserve local-first behavior and avoid introducing accounts, tracking, or background network activity.
- Do not add clinical or medical claims about ADHD or other conditions.

## Development

```bash
npm install --ignore-scripts
npm test
node tests/ui-smoke.cjs
```

Run `npm run package:mac` for an Apple Silicon macOS build.

## Pull Requests

Explain the user problem, summarize the behavior change, and include the tests you ran. Add or update focused tests when changing persistence, file handling, exports, or the user interface.
