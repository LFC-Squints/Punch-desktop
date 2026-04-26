# Hosting Punch on GitHub + Auto-Updates

This guide takes you from "source code on my laptop" to "users get update prompts in-app when I ship a new version." One-time setup is about 15 minutes. After that, shipping a new release is a two-command process.

## How auto-updates work

Punch uses `electron-updater`, which watches a GitHub Releases feed for new versions. When a user clicks **Check for updates** (or launches the app — it checks silently 5 seconds after startup), their installed Punch fetches the latest release from your repo, compares the version in `package.json` to what's released, and if newer, offers to download and install.

The delivery path is: your machine → `electron-builder` → GitHub Release (draft) → your users' installed Punch → they see an "Update available" banner → they click Install → Punch restarts on the new version.

## One-time setup

### 1. Create the GitHub repo

Go to github.com and create a new repo named `punch-desktop`. Public or private both work. **Do not** initialize it with a README — you're pushing an existing project in.

### 2. Wire your local folder to GitHub

Open PowerShell in `G:\Punch\punch-desktop` and run:

```powershell
git init
git add .
git commit -m "Initial commit of Punch v1.2"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/punch-desktop.git
git push -u origin main
```

If you don't have git installed, grab it from git-scm.com. The installer includes a Windows-friendly bash/PowerShell integration.

### 3. Update `package.json` with your GitHub username

Open `package.json` and find this section:

```json
"publish": {
  "provider": "github",
  "owner": "YOUR_GITHUB_USERNAME",
  "repo": "punch-desktop"
}
```

Change `YOUR_GITHUB_USERNAME` to your actual GitHub username. Commit and push this change — the installed app reads this to know where to check for updates.

### 4. Create a GitHub Personal Access Token

This lets `electron-builder` upload your built installer to GitHub on your behalf. You only do this once.

1. Go to github.com → your profile icon → Settings → Developer settings → Personal access tokens → **Tokens (classic)**
2. Click **Generate new token (classic)**
3. Name it something like "punch-desktop-publisher"
4. Set expiration to whatever you're comfortable with (90 days, 1 year, or "no expiration" for set-and-forget)
5. Check the **`repo`** scope (the whole top-level checkbox)
6. Click **Generate token** and **copy it immediately** — GitHub won't show it again

### 5. Save the token as an environment variable

In PowerShell (run as yourself, not admin):

```powershell
[System.Environment]::SetEnvironmentVariable('GH_TOKEN', 'ghp_YourTokenHere', 'User')
```

Close and reopen PowerShell. Confirm it took:

```powershell
echo $env:GH_TOKEN
```

You should see your token echoed back.

## Shipping a new release

Once the one-time setup is done, the flow for every new release is simple.

### 1. Bump the version

Open `package.json` and increment the version. Use semantic versioning:

- Patch (bug fix): 1.2.0 → 1.2.1
- Minor (new feature, backward compatible): 1.2.0 → 1.3.0
- Major (breaking change): 1.2.0 → 2.0.0

### 2. Commit and push

```powershell
git add .
git commit -m "v1.2.1: fix timer drift on sleep"
git push
```

### 3. Build and publish

```powershell
npm run dist:publish
```

This builds the installer AND uploads it to GitHub as a draft release. (If it fails with a symlink error, run PowerShell as administrator.)

### 4. Publish the draft on GitHub

Go to `github.com/YOUR_USERNAME/punch-desktop/releases`. You'll see a draft release with the version number. Click it, write a short changelog in the description (what's new, what's fixed), and click **Publish release**.

The moment you publish, every installed copy of Punch out in the wild will detect the update on its next silent check or "Check for updates" click.

### 5. Test the update yourself

On another computer (or the same one with an older version installed), open Punch → Settings → **About & updates** → **Check for updates**. You should see "Update available: v1.2.1" with a Download button. Click it, wait for the progress bar, then click **Restart & install**.

## Troubleshooting

**"Update error: 404"** on the first check — this usually means either the `owner` in `package.json` doesn't match your GitHub username, or there's no published release yet (drafts don't count). Publish at least one release, then re-check.

**"Update error: ENOENT latest.yml"** — `electron-builder` forgot to include `latest.yml` in the release. Delete the release, delete the tag, and re-run `npm run dist:publish`.

**Build fails with "cannot create symbolic link"** — PowerShell needs admin rights to create symlinks during the Electron build. Right-click PowerShell → Run as administrator, then retry.

**Token expired** — generate a new Personal Access Token and re-run step 5 above.

**SmartScreen warns users on update install** — this is the same unsigned-binary warning as the first install. The update still works; users click "More info → Run anyway" once. The fix is code-signing, covered in the main README.

## Private repo considerations

If you keep the repo private, users also need a GitHub token to receive updates. This is friction for distribution. Two options:

1. Make the repo public. Your source code is visible but your data stays local. Most personal tools go this route.
2. Keep it private and distribute the installer manually via Teams/SharePoint — but then you lose the auto-update feature.

For a tool like Punch distributed to a known set of franchise owners, **public repo + code signing** is the cleanest long-term path. The source being public doesn't hurt anything — there's no secret sauce in the code, and the local data never leaves the user's machine.

## What your release workflow looks like going forward

```
Edit code → bump version in package.json → git commit → git push
→ npm run dist:publish → go to GitHub, publish draft → done.
```

Users get the update silently. Total time per ship: ~3 minutes.
