# AGENTS.md

Instructions for any AI coding agent working in this repository (Codex, Claude, Cursor, Gemini, and others). Project-specific truth lives here so a fresh agent is never guessing.

## What this is

A small public web service that hands out free golf-course data — search ~14,700 US courses by name or state, then get that course's scorecard, tee boxes, climate averages and nearby hotels/restaurants, as JSON. It also had two "send us data" endpoints: submit a missing course, and upload anonymized GPS "moments" from a golf app. 

## Stack

Node/TypeScript + Cloudflare Workers + Supabase

## Commands

- `npm install` — install dependencies
- `npm run dev` — dev
- `npm run test` — test
- `npm run typecheck` — typecheck
- `npm run deploy` — deploy

## Working here

- Always open a pull request; never push straight to the default branch. Other people and agents work in these repos.
- Verify a claim against the running system before repeating it. A number in a doc without a date and a method is a rumour.
- Match the surrounding code's style and conventions.
- On start, read `.gstack/inbox.md` for messages and proposals from G-Stat (the cross-project advisor). Act on or reply to anything addressed to this repo.
