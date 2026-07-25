import { defineConfig } from 'vite'

export default defineConfig({
  // GitHub Pages serves the site from /<repo-name>/
  base: process.env.GITHUB_ACTIONS ? '/famicom-cartridge-tool/' : '/',
})
