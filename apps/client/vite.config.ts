import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { copyFileSync } from 'node:fs'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react(), { name: 'copy-launcher-icon', closeBundle() { copyFileSync(resolve('android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png'), resolve('dist/app-icon.png')) } }],
})
