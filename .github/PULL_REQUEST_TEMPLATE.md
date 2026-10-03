## What and why

<!-- One or two sentences. Link the issue if there is one. -->

## Checklist

- [ ] `upstream/` is untouched (phone-specific changes live in `mobile/`)
- [ ] `npx tsc --noEmit -p .` and `npx vitest run` pass in `mobile/`
- [ ] UI changes: `npm run ui:audit` shows no new issues (or the PR explains why)
- [ ] No personal data in code, tests, screenshots or reports (paths, IPs, usernames)
