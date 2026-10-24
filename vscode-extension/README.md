# DepExit for VS Code

Brings the DepExit **Dependency Exit Capsule** into the editor:

- **Diagnostics** on every manifest line and usage location (`file:line`) of an at-risk dependency. Private-API use
  and monkeypatching are called out.
- **Hover:** risk indicators, the Gemma 4 rationale and proposal, migration steps and the test gaps measured in Docker.
- **Quick fix:** "replace file with its migrated version". Opens a diff against the version that was tested in the
  sandbox, then applies it only after you confirm.
- **Status bar:** the at-risk count and verdict. Click it to open `CAPSULE.md` as a Markdown preview.

## Use
1. Start DepExit (`run.ps1` or `make dev` in the repo root) so the API is on `http://localhost:8080`.
2. Run **DepExit: Analyze This Workspace** and enter any GitHub repository (`https://github.com/owner/repo`,
   `github.com/owner/repo`, `git@github.com:owner/repo.git` or a `/tree/<branch>` link). The URL defaults to the open
   folder's `git remote origin`. DepExit checks that the API, AI service and Docker are up, then the server clones and
   analyses the repository; progress shows the running stage.
3. When it finishes:
   - if the open folder is that repository, the results appear in its files right away;
   - otherwise choose **Clone & Open**: the extension clones the repository locally at the exact analysed commit
     (branch `depexit/<id>`), opens it, and loads the results there automatically. Needs Git on `PATH`.
4. **DepExit: Load Analysis by ID** lists finished analyses; **DepExit: Clone Analysed Repository & Open** clones the
   loaded one. If an analysis fails, the message names the failed stage and its error (also in the DepExit output).

**Sign in with GitHub:** run **DepExit: Sign in with GitHub**. A browser tab opens, you approve, and VS Code receives
the session through its URI handler (`DepExit: Sign Out` clears it). Needs `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` in the
repo `.env` (see `.env.example`).

Settings: `depexit.apiUrl`, `depexit.minLevel`.

## Run from source
Open this folder in VS Code and press **F5** (Extension Development Host). Packaging: `npx @vscode/vsce package`.
