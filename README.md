# RIGGED Discord Activity Build

This folder is split into normal web files so it can be uploaded to GitHub.

Before deploying to Discord:

1. Open `index.html`.
2. Replace `REPLACE_WITH_YOUR_DISCORD_CLIENT_ID` with your Discord application Client ID.
3. Host this folder on HTTPS, for example GitHub Pages, Cloudflare Pages, Netlify, or Vercel.
4. In the Discord Developer Portal, point your Activity URL to the hosted `index.html`.

Local browser testing is safe. Outside Discord, the SDK bootstrap shows `Discord SDK: local preview` and the game runs normally.
