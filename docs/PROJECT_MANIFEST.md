# Project manifest and project extension guide

`ProjectManifest` is the reviewed declarative input for project detection, desktop preferences, retrieval scope,
services, checks, and policy-gated workflows. The authoritative copy lives in Workbench SQLite. A project-local
`.ai-workbench-manifest.json` or `workbench.project.json` is an import/export surface only; changing it creates a
proposal and never silently replaces canonical configuration.

The TypeScript type and runtime validator in `packages/contracts/src/types.ts` and
`packages/contracts/src/validation.ts` are authoritative. Every manifest carries schema version `1`, stable project
ID, timestamps, origin, and capability flags.

## Shape

| Field | Purpose |
| --- | --- |
| `id`, `name`, `path` | Stable canonical identity and absolute project path. The ID must match the Workbench project receiving an import. |
| `kind` | `repository`, `monorepo`, `workspace`, `dotfiles`, or `unknown`. |
| `repositoryRoot`, `workspaceRoots`, `approvedRoots` | Canonical containment boundaries. Relative workspace roots stay under the repository; approved roots are absolute. |
| `packageManager` | Explicit project-native manager or `unknown`; explicit configuration wins over bounded marker detection. |
| `applications` | Named applications/packages with relative paths and product-specific kinds. |
| `detection` | Bounded root markers, Git remotes, and user-facing aliases. Detection is evidence, not durable ownership. |
| `commands` | Structured workflow commands. Shell strings, interpolation, pipes, redirects, and substitutions are not accepted. |
| `checks`, `services` | Canonical check IDs and service/health definitions. Compose profiles belong to service definitions. |
| `desktop` | tmux session, preferred editor, scratchpads, and scene preference; desktop clients only consume this projection. |
| `ai` | Retrieval profile, model role, boost/include/exclude paths, checks, and project-scoped MCP capabilities. |
| `secretRefs` | Approved secret names only. Secret values never belong in a manifest, cache, API response, or event. |

Minimal example:

```json
{
  "schemaVersion": 1,
  "id": "project-id-from-workbench",
  "createdAt": "2026-07-20T00:00:00.000Z",
  "updatedAt": "2026-07-20T00:00:00.000Z",
  "origin": { "source": "import", "instanceId": "local", "legacyRef": null },
  "capabilities": ["desktop", "retrieval", "workflows"],
  "name": "Example",
  "path": "/home/user/code/example",
  "kind": "repository",
  "repositoryRoot": "/home/user/code/example",
  "workspaceRoots": [],
  "packageManager": "pnpm",
  "applications": [],
  "detection": { "markers": ["package.json"], "remotes": [], "aliases": ["example"] },
  "commands": {},
  "checks": [],
  "services": [],
  "desktop": { "tmuxSession": "example", "preferredEditor": "code", "scratchpads": ["ai"], "scene": null },
  "ai": {
    "retrievalProfile": "standard",
    "defaultModelRole": "coding",
    "boostPaths": ["src"],
    "include": [],
    "exclude": ["node_modules", "dist"],
    "checks": [],
    "mcpCapabilities": ["search", "context"]
  },
  "secretRefs": [],
  "approvedRoots": ["/home/user/code/example"]
}
```

## Add a project

1. Register the path once: `ai project add /absolute/path --name "Example"`.
2. Copy the returned project ID into the manifest. Do not invent a second ID for the same checkout.
3. Run `ai project import manifest.json --project <id>` for a mutation-free validation and field diff.
4. Run the same command with `--apply` to create a pending proposal. Apply does **not** approve it.
5. Review the diff, then run `ai project proposal approve <proposal-id>` or reject it.
6. Verify `ai project export <id> --output exported.json`, `ai project pin <id>`, `ai context explain`, and
   `ai context status --compact`.
7. Keep the local manifest under review like code. A later scan/import creates another proposal rather than merging
   behind the user's back.

When automatic detection is sufficient, `ai project scan <id> --apply` proposes either supported local filename.
Legacy profiles can be parsed without execution through `ai project import-legacy`; they follow the same pending
proposal boundary.

## Add a workflow

Each `commands` entry declares executable and argument arrays, working directory, environment-reference names,
interactivity, execution mode, mutation class, timeout/retry policy, typed artifacts, success criteria, recovery
workflow IDs, capabilities, and visibility conditions. Canonical approval synchronizes these entries into SQLite
workflow definitions; callers cannot execute the manifest as a shell file.

Use the narrowest mutation class and the execution mode that preserves review boundaries. `direct`, `terminal`,
`tmux`, `isolated`, and `background` are supported through the shared policy/execution system. Mutating commands
require context-bound approval; destructive/high-risk operations cannot self-approve through MCP or Rofi. See
[WORKFLOW_EXECUTION.md](./WORKFLOW_EXECUTION.md) for the complete command example, DAGs, artifacts, cleanup, recovery,
secret delivery, and review flow.

## Safety checklist

- Resolve every root canonically and reject symlink escapes.
- Keep arguments structured and validate user-supplied safe arguments separately.
- Reference secret names in both `secretRefs` and the command's `environmentRefs`; never store values.
- Prefer project-native checks and package managers; never invent a universal `npm run dev`.
- Set timeouts and explicit mutation classes.
- Review project, branch, base commit, workspace, diff, and approval age before apply.
- Export the canonical manifest and take a SQLite backup before destructive migration.

