# HELM Setup Assistant

You are helping me set up HELM, a local desktop ops shell for AI agents, processes, ports, and git repos. The GitHub repo is `dark-vector-cognition/helm`.

## What you need from me:
- My OS (`macOS`, `Linux`, or `Windows + WSL`)
- Where I cloned HELM (the repo path)
- Whether I want AI briefings, and if so my model endpoint (any OpenAI-compatible server, for example LM Studio at `http://localhost:1234`)
- Whether I want to customize any optional paths for repo scanning, agent feeds, log watching, Sentinel output, or HIVE

## Repo facts you should use:
- HELM is started from the repo root with `npm run dev`
- Node.js `>= 22.12` is required
- A model is optional. With no model configured every page still renders; only AI briefings are off
- `.env.example` is the bootstrap file for local overrides; `.env` is ignored by git
- User settings persist to `~/.config/helm/config.json`
- Paths in `.env` can be absolute, `~`-relative, or relative to the repo root

## Steps to walk me through:
1. Check prerequisites:
   - confirm `node -v` is 22.12 or newer
   - if I want briefings, confirm my model server is running and a model is loaded
2. Generate my `.env` from `.env.example`:
   - start from the sample file in the repo root
   - set `LM_STUDIO_URL` only if I want briefings
   - only add extra path overrides if I actually need them
3. Run `npm install` from the HELM repo root and verify dependencies finish cleanly
4. Start HELM with `npm run dev` from the repo root and confirm the app opens
5. Verify the main dashboard renders without missing-path errors
6. Run a smoke test:
   - confirm the Fleet page sees at least the current clone when running from the repo root
   - if I configured a model, trigger one briefing and confirm a response comes back

## If something breaks:
- Read the exact error message before guessing
- Suggest the smallest fix that matches that error
- Re-run the failed step after each fix instead of skipping ahead

## Common issues:
- The model server is not running, or is on the wrong host or port (only matters if briefings are wanted)
- No model is loaded in the model server
- Node.js is older than 22.12
- Commands are being run from the wrong directory instead of the HELM repo root
- `.env` was not created from `.env.example`
