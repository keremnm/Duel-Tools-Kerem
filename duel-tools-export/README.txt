# Duel Tools

Yu-Gi-Oh replay scraping and analysis tool for DuelingBook.
Based on https://github.com/nedhmn/duel-tools

## Setup (one time)

1. Install Node.js from https://nodejs.org (LTS version)
2. Install the Relay userscript in Tampermonkey:
   - Open Tampermonkey → Dashboard → Create new script
   - Delete the default code
   - Paste the contents of public/relay.user.js
   - Press Ctrl+S to save

## Running

**Windows:** Double-click START.bat
**Mac/Linux:** node server/server.js

App opens automatically at http://localhost:8000

## How to use

1. Enter a batch name and player username in the sidebar
2. Paste replay URLs (or any text containing duelingbook replay URLs)
3. Hit Analyze — replays load silently in the background
4. Batches are saved automatically and persist between sessions
5. Switch between RPS Analysis and Deck Viewer tabs
6. Select a match from the Deck Viewer sidebar to see cards per game

## Features

- Batch management with persistent storage
- RPS pick analysis (overall, first pick, post-tie)
- Deck viewer with per-game and full-match card grids
- Card images from ygoprodeck.com
- YDK deck file export
- Screenshot capture
- Goat Format banlist enforced on card counts
